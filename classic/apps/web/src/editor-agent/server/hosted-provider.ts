/** Account-scoped credential/network adapter. Editing and media processing stay
 * in the browser's canonical Rust runtime. No computer or shell tools run here. */
import { join } from "node:path";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { onAccountDisconnect } from "@/accounts/lifecycle";
import * as vault from "@/generative/server/vault";

const API = "https://openrouter.ai/api/v1";
const LEASE_MS = 15 * 60_000;
const MAX_REQUESTS = 40;
type Lease = {
	root: string;
	until: number;
	remaining: number;
	controllers: Set<AbortController>;
};
const host = globalThis as typeof globalThis & {
	__pocutHostedAgentLeases?: Map<string, Lease>;
	__pocutHostedAgentConnecting?: Set<string>;
	__pocutHostedAgentEpochs?: Map<string, number>;
};
const leases = (host.__pocutHostedAgentLeases ??= new Map());
const connecting = (host.__pocutHostedAgentConnecting ??= new Set());
const epochs = (host.__pocutHostedAgentEpochs ??= new Map());
onAccountDisconnect({
	name: "hosted-agent-provider",
	listener(owner) {
		epochs.set(owner, (epochs.get(owner) ?? 0) + 1);
		const lease = leases.get(owner);
		if (lease) {
			for (const controller of lease.controllers) controller.abort();
			vault.lock(lease.root);
		}
		leases.delete(owner);
	},
});
const root = () => join(accountDataRoot(), "generative");
const modelSchema = z.object({
	id: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	architecture: z.object({
		input_modalities: z.array(z.string()),
		output_modalities: z.array(z.string()),
	}),
	supported_parameters: z.array(z.string()),
	endpoints: z.array(z.string()).optional(),
});

function leaseForAccount() {
	const owner = requireAccount().id;
	const lease = leases.get(owner);
	if (!lease || lease.until <= Date.now() || !vault.seconds(root())) {
		if (lease) for (const request of lease.controllers) request.abort();
		leases.delete(owner);
		throw new Error(
			"Unlock the Agent with your PIN to authorize up to 40 paid AI requests for 15 minutes.",
		);
	}
	return lease;
}

export async function hostedProviderStatus() {
	let lease: Lease | undefined;
	try {
		lease = leaseForAccount();
	} catch {
		/* Disconnected is a normal state. */
	}
	return {
		provider: "openrouter" as const,
		connected: await vault.configured(root()),
		sharing: !!lease && lease.remaining > 0,
		connecting: connecting.has(requireAccount().id),
		identity: lease ? { name: "OpenRouter", email: undefined } : null,
		error: null,
		usageUrl: "https://openrouter.ai/activity",
		sessionSeconds: lease
			? Math.max(
					0,
					Math.min(
						vault.seconds(root()),
						Math.floor((lease.until - Date.now()) / 1000),
					),
				)
			: 0,
		remainingRequests: lease?.remaining ?? 0,
	};
}

export async function connectHostedProvider(input: {
	pin: string;
	apiKey?: string;
	confirmed: boolean;
}) {
	if (input.confirmed !== true)
		throw new Error("Confirm paid Agent usage before connecting.");
	const owner = requireAccount().id;
	if (connecting.has(owner) || connecting.size >= 2)
		throw new Error("A provider connection is in progress. Try again shortly.");
	connecting.add(owner);
	const epoch = epochs.get(owner) ?? 0;
	try {
		if (input.apiKey !== undefined)
			await vault.setup({ root: root(), pin: input.pin, key: input.apiKey });
		await vault.unlock({ root: root(), pin: input.pin });
		if ((epochs.get(owner) ?? 0) !== epoch) {
			vault.lock(root());
			throw new Error("The account signed out while connecting.");
		}
		const previous = leases.get(owner);
		if (previous) for (const request of previous.controllers) request.abort();
		leases.set(owner, {
			root: root(),
			until: Date.now() + LEASE_MS,
			remaining: MAX_REQUESTS,
			controllers: new Set(),
		});
		return await hostedProviderStatus();
	} finally {
		connecting.delete(owner);
	}
}

export function disconnectHostedProvider() {
	const owner = requireAccount().id;
	// A disconnect cannot race an in-flight PIN verification into a new lease.
	if (connecting.has(owner))
		throw new Error(
			"Wait for the provider connection to finish, then lock it.",
		);
	const lease = leases.get(owner);
	if (lease) for (const request of lease.controllers) request.abort();
	leases.delete(owner);
	vault.lock(root());
	return { revocationConfirmed: true };
}

async function boundedJson({
	response,
	limit,
}: {
	response: Response;
	limit: number;
}) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The provider returned an empty model catalog.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit)
				throw new Error("Provider model catalog exceeds its limit.");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function hostedProviderModels(signal?: AbortSignal) {
	const lease = leaseForAccount();
	const response = await fetch(`${API}/models/user`, {
		headers: { Authorization: `Bearer ${vault.keyFor(root())}` },
		redirect: "error",
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
			: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`OpenRouter model discovery failed (${response.status}). Check your API key.`,
		);
	}
	const body = z
		.object({ data: z.array(z.unknown()).max(5000) })
		.parse(await boundedJson({ response, limit: 8_000_000 }));
	if (leases.get(requireAccount().id) !== lease)
		throw new Error("The provider connection changed.");
	return body.data
		.flatMap((value) => {
			const parsed = modelSchema.safeParse(value);
			if (!parsed.success) return [];
			const item = parsed.data;
			if (
				!item.supported_parameters.includes("tools") ||
				!item.architecture.input_modalities.includes("text") ||
				!item.architecture.input_modalities.includes("image") ||
				!item.architecture.output_modalities.includes("text") ||
				(item.endpoints && !item.endpoints.includes("/api/v1/responses"))
			)
				return [];
			return [{ id: item.id, name: item.name }];
		})
		.slice(0, 200);
}

/** At most one paid HTTP attempt. A missing response can already be billed;
 * callers must never retry it automatically, including after a broken stream. */
export async function streamHostedProvider({
	body,
	signal,
}: {
	body: Record<string, unknown>;
	signal: AbortSignal;
}) {
	const lease = leaseForAccount();
	if (lease.remaining <= 0)
		throw new Error(
			"The 40-request Agent authorization is used. Unlock again to continue.",
		);
	const models = await hostedProviderModels(signal);
	if (!models.some((model) => model.id === body.model))
		throw new Error(
			"Choose an available vision and tool-capable OpenRouter model.",
		);
	if (lease !== leaseForAccount())
		throw new Error("The provider connection changed.");
	if (lease.remaining <= 0)
		throw new Error(
			"The 40-request Agent authorization is used. Unlock again to continue.",
		);
	const active = [...leases.values()].reduce(
		(count, item) => count + item.controllers.size,
		0,
	);
	if (lease.controllers.size >= 2 || active >= 16)
		throw new Error(
			"The Agent is busy. Wait for the current request to finish.",
		);
	const tools = Array.isArray(body.tools) ? body.tools : [];
	if (
		tools.some(
			(tool) => !tool || typeof tool !== "object" || tool.type !== "function",
		)
	)
		throw new Error(
			"This connection supports editor function tools. Provider-hosted web search is unavailable.",
		);
	const controller = new AbortController();
	lease.controllers.add(controller);
	lease.remaining--;
	const combined = AbortSignal.any([
		signal,
		controller.signal,
		AbortSignal.timeout(
			Math.max(1, Math.min(180_000, lease.until - Date.now())),
		),
	]);
	const cleanup = () => lease.controllers.delete(controller);
	try {
		const { include: _include, reasoning: _reasoning, ...input } = body;
		const response = await fetch(`${API}/responses`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${vault.keyFor(root())}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			redirect: "error",
			body: JSON.stringify({
				...input,
				max_output_tokens: 4096,
				store: false,
				stream: true,
				provider: { allow_fallbacks: false, require_parameters: true },
			}),
			signal: combined,
		});
		if (
			!response.ok ||
			!response.body ||
			!response.headers.get("content-type")?.includes("text/event-stream")
		) {
			await response.body?.cancel();
			throw new Error(
				`OpenRouter did not complete the request (${response.status}). No paid retry was sent.`,
			);
		}
		const reader = response.body.getReader();
		let size = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(output) {
					try {
						combined.throwIfAborted();
						const chunk = await reader.read();
						if (chunk.done) {
							cleanup();
							output.close();
							return;
						}
						size += chunk.value.byteLength;
						if (size > 16_000_000)
							throw new Error("Provider response exceeds its limit.");
						output.enqueue(chunk.value);
					} catch (error) {
						controller.abort();
						cleanup();
						await reader.cancel().catch(() => {});
						output.error(error);
					}
				},
				async cancel() {
					controller.abort();
					cleanup();
					await reader.cancel();
				},
			}),
			{
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
					"X-OpenCut-Provider-Retry": "never",
				},
			},
		);
	} catch (error) {
		cleanup();
		throw error;
	}
}
