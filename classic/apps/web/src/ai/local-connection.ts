import type { LocalProvider } from "./companion/protocol";
import {
	COMPANION_URL,
	SETUP_HEADER,
	SETUP_LIFETIME_MS,
	SETUP_PATH,
	companionSetupSchema,
	type CompanionSetup,
} from "./companion/setup";

export interface ClientAiPairing {
	version: 1;
	origin: string;
	accountId: string;
	token: string;
}
const key = (id: string) => `opencut-client-ai:${id}`;
const setupKey = (id: string) => `pocut-client-ai-setup:${id}`;
const providerKey = (id: string) => `pocut-local-provider:${id}`;
export function readClientAiPairing(): ClientAiPairing | null {
	const id = window.__opencutAccountId;
	if (!id) return null;
	try {
		const pair = JSON.parse(sessionStorage.getItem(key(id)) ?? "null");
		return pair?.version === 1 &&
			pair.accountId === id &&
			pair.origin === window.location.origin &&
			/^[a-f0-9]{64}$/.test(pair.token)
			? pair
			: null;
	} catch {
		return null;
	}
}
export function prepareClientAiPairing(): ClientAiPairing {
	const id = window.__opencutAccountId;
	if (!id) throw new Error("Sign in to POCUT first");
	const pair = readClientAiPairing() ?? {
		version: 1 as const,
		origin: window.location.origin,
		accountId: id,
		token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
			n.toString(16).padStart(2, "0"),
		).join(""),
	};
	sessionStorage.setItem(key(id), JSON.stringify(pair));
	return pair;
}
function readClientAiSetup(account: string) {
	try {
		const saved = JSON.parse(
			sessionStorage.getItem(setupKey(account)) ?? "null",
		);
		const config = companionSetupSchema.parse(saved?.config);
		if (config.origin !== window.location.origin) return null;
		const paired = saved.paired === true && readClientAiPairing() !== null;
		return paired || config.expiresAt > Date.now() ? { config, paired } : null;
	} catch {
		return null;
	}
}

export function prepareClientAiSetup(): CompanionSetup {
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in to POCUT first");
	const saved = readClientAiSetup(account);
	if (saved) return saved.config;
	const setup = companionSetupSchema.parse({
		version: 1,
		origin: window.location.origin,
		setupId: crypto.randomUUID(),
		expiresAt: Date.now() + SETUP_LIFETIME_MS,
	});
	sessionStorage.setItem(
		setupKey(account),
		JSON.stringify({ config: setup, paired: false }),
	);
	return setup;
}

export async function completeClientAiSetup({
	signal,
}: {
	signal: AbortSignal;
}) {
	const account = window.__opencutAccountId;
	if (!account) return false;
	const saved = readClientAiSetup(account);
	if (!saved || saved.paired) return false;
	const setup = saved.config;
	const url = COMPANION_URL + SETUP_PATH;
	const init: RequestInit = {
		credentials: "omit",
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
		headers: { [SETUP_HEADER]: setup.setupId },
	};
	const ready = await fetch(url, init).catch(() => null);
	signal.throwIfAborted();
	if (
		!ready?.ok ||
		(await ready.json().catch(() => null))?.setupId !== setup.setupId
	)
		throw new Error(
			"Give the pairing ZIP to your AI assistant and allow local-network access before connecting.",
		);
	if (
		window.__opencutAccountId !== account ||
		readClientAiSetup(account)?.config.setupId !== setup.setupId
	)
		throw new Error("Account or pairing instructions changed. Connect again.");
	init.signal?.throwIfAborted();
	const response = await fetch(url, {
		...init,
		method: "POST",
		headers: {
			[SETUP_HEADER]: setup.setupId,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(prepareClientAiPairing()),
	});
	if (!response.ok)
		throw new Error(
			"Could not pair this tab with the local companion. Download fresh instructions and try again.",
		);
	if (window.__opencutAccountId !== account)
		throw new Error("Account changed. Connect again.");
	sessionStorage.setItem(
		setupKey(account),
		JSON.stringify({ config: setup, paired: true }),
	);
	return true;
}

export function forgetClientAiPairing() {
	const id = window.__opencutAccountId;
	if (id) {
		sessionStorage.removeItem(key(id));
		sessionStorage.removeItem(setupKey(id));
		sessionStorage.removeItem(providerKey(id));
	}
}
export function readLocalProvider(): LocalProvider | null {
	if (typeof window === "undefined") return null;
	const id = window.__opencutAccountId;
	if (!id) return null;
	try {
		const value = sessionStorage.getItem(providerKey(id));
		return value === "codex" || value === "claude" ? value : null;
	} catch {
		return null;
	}
}
export function selectLocalProvider(provider: LocalProvider | null) {
	const id = window.__opencutAccountId;
	if (!id) throw new Error("Sign in to POCUT first");
	if (provider) {
		prepareClientAiPairing();
		sessionStorage.setItem(providerKey(id), provider);
	} else sessionStorage.removeItem(providerKey(id));
	window.dispatchEvent(new Event("opencut-ai-provider-changed"));
}
const allowed = new Set([
	"/api/editor-agent/connection",
	"/api/editor-agent/respond",
	"/api/ai/chat",
	"/api/ai/models",
	"/api/ai/oauth/status",
	"/api/ai/local-image",
]);
export async function connectedProviderFetch({
	path,
	init = {},
	providerOverride,
}: {
	path: string;
	init?: RequestInit;
	providerOverride?: LocalProvider | null;
}) {
	if (!allowed.has(path)) throw new Error("Unsupported provider operation");
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in to POCUT first");
	const selected = readLocalProvider();
	const provider = providerOverride === undefined ? selected : providerOverride;
	const pair = provider ? readClientAiPairing() : null;
	if (provider && !pair)
		throw new Error("Pair this workspace with the local companion first");
	const controller = new AbortController();
	const changed = () => {
		if (
			window.__opencutAccountId !== account ||
			readLocalProvider() !== selected
		)
			controller.abort();
	};
	const leaving = () => controller.abort();
	window.addEventListener("storage", changed);
	window.addEventListener("opencut-ai-provider-changed", changed);
	window.addEventListener("pagehide", leaving, { once: true });
	const cleanup = () => {
		window.removeEventListener("storage", changed);
		window.removeEventListener("opencut-ai-provider-changed", changed);
		window.removeEventListener("pagehide", leaving);
	};
	const headers = new Headers(init.headers);
	headers.set("X-OpenCut-Account", account);
	if (pair && provider) {
		headers.set("Authorization", `Bearer ${pair.token}`);
		headers.set("X-POCUT-Provider", provider);
	}
	let streaming = false;
	try {
		const response = await fetch((provider ? COMPANION_URL : "") + path, {
			...init,
			credentials: provider ? "omit" : "same-origin",
			cache: "no-store",
			signal: init.signal
				? AbortSignal.any([init.signal, controller.signal])
				: controller.signal,
			headers,
		});
		changed();
		if (controller.signal.aborted)
			throw new Error("Account changed or the provider changed");
		if (!response.body) return response;
		const reader = response.body.getReader();
		streaming = true;
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(stream) {
					try {
						changed();
						controller.signal.throwIfAborted();
						const { done, value } = await reader.read();
						changed();
						controller.signal.throwIfAborted();
						if (done) {
							cleanup();
							stream.close();
						} else stream.enqueue(value);
					} catch (error) {
						cleanup();
						await reader.cancel().catch(() => {});
						stream.error(error);
					}
				},
				async cancel(reason) {
					cleanup();
					await reader.cancel(reason);
				},
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	} catch (error) {
		if (error instanceof TypeError && provider)
			throw new Error(
				"Start the POCUT companion on this device and allow your browser's local-network connection, then retry.",
			);
		throw error;
	} finally {
		if (!streaming) cleanup();
	}
}
/** Only call from the explicit human image-review button. No automatic retries. */
export async function generateConnectedImage({
	projectId,
	operationId,
	prompt,
	references = [],
	confirmed,
	signal,
}: {
	projectId: string;
	operationId: string;
	prompt: string;
	references?: string[];
	confirmed: true;
	signal: AbortSignal;
}): Promise<{ blob: Blob; mimeType: string; lastModified: number }> {
	if (confirmed !== true)
		throw new Error(
			"Connect the local Codex provider and confirm image generation first",
		);
	const account = window.__opencutAccountId;
	const selected = readLocalProvider();
	const response = await connectedProviderFetch({
		providerOverride: "codex",
		path: "/api/ai/local-image",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				projectId,
				operationId,
				prompt,
				references,
				confirmed,
			}),
			signal,
		},
	});
	const value = await response.json();
	if (!response.ok)
		throw new Error(
			typeof value.error === "string"
				? value.error
				: "Image generation did not complete",
		);
	if (window.__opencutAccountId !== account || readLocalProvider() !== selected)
		throw new Error("The image account changed");
	if (
		!["image/png", "image/jpeg", "image/webp"].includes(value.mimeType) ||
		typeof value.base64 !== "string" ||
		value.base64.length > 24_000_000
	)
		throw new Error("Invalid generated image response");
	const bytes = Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0));
	return {
		blob: new Blob([bytes], { type: value.mimeType }),
		mimeType: value.mimeType,
		lastModified: typeof value.completedAt === "number" ? value.completedAt : 0,
	};
}
