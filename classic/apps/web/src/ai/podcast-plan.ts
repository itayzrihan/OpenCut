/** Bounded model transport. Rust validates every proposal; no timeline edits here. */
import { z } from "zod";
import {
	requestAgentResponse,
	type ProviderFailureInput,
	type ProviderRetryPlan,
} from "@/editor-agent/transport";
import type {
	PodcastOptions,
	PodcastSource,
	PodcastVideo,
} from "./podcast-types";
export { parsePodcastProposal, podcastVideoSchema } from "./podcast-proposal";
import { runPodcastEditorial } from "./podcast-editorial";
export async function requestPodcastPlan({
	source,
	options,
	signal,
	onStage,
	review,
	planRetry,
	assertScope,
	cache,
	onProviderRequest,
	onResume,
	onReport,
}: {
	source: PodcastSource;
	options: PodcastOptions;
	signal: AbortSignal;
	onStage: (message: string) => void;
	review: (input: { options: PodcastOptions; videos: PodcastVideo[] }) => void;
	onProviderRequest?: () => void;
	onResume?: (savedResponses: number) => void;
	onReport?: (report: Record<string, unknown>) => void;
	planRetry?: (failure: ProviderFailureInput) => ProviderRetryPlan;
	assertScope?: () => void;
	cache?: {
		key: string;
		storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	};
}): Promise<PodcastVideo[]> {
	const account = window.__opencutAccountId;
	if (!account) throw new Error("Sign in and connect ChatGPT first");
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	window.addEventListener("pagehide", abort, { once: true });
	const assertCurrent = () => {
		assertScope?.();
		signal.throwIfAborted();
		controller.signal.throwIfAborted();
		if (window.__opencutAccountId !== account)
			throw new Error("Account changed; the podcast proposal was discarded");
	};
	const headers = {
		"Content-Type": "application/json",
		"X-OpenCut-Account": account,
	};
	try {
		assertCurrent();
		const response = await fetch("/api/editor-agent/connection", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
			signal: controller.signal,
			headers,
			body: JSON.stringify({ operation: "models" }),
		});
		const value = await response.json();
		assertCurrent();
		if (!response.ok)
			throw new Error(
				typeof value.error === "string" ? value.error : "Connect ChatGPT first",
			);
		const model = z
			.object({ models: z.array(z.object({ id: z.string() })) })
			.parse(value).models[0]?.id;
		if (!model) throw new Error("No ChatGPT model available");
		const askRaw = async ({
			instructions,
			prompt,
		}: {
			instructions: string;
			prompt: string;
		}) => {
			assertCurrent();
			const deadline = new AbortController();
			const requestSignal = AbortSignal.any([
				controller.signal,
				deadline.signal,
			]);
			const timeout = setTimeout(
				() => deadline.abort(new Error("Podcast model request timed out")),
				240000,
			);
			try {
				const raw = await requestAgentResponse({
					signal: requestSignal,
					beforeAttempt: assertCurrent,
					onEvent: assertCurrent,
					onRetry: (attempt) =>
						onStage(
							`ChatGPT temporarily busy · retrying request after attempt ${attempt} · analyzed windows remain saved`,
						),
					planRetry:
						planRetry ?? (() => ({ retry: false, delayMs: 0, maxAttempts: 1 })),
					send: () => {
						onProviderRequest?.();
						return fetch("/api/editor-agent/respond", {
							method: "POST",
							credentials: "same-origin",
							cache: "no-store",
							signal: requestSignal,
							headers,
							body: JSON.stringify({
								model,
								instructions,
								input: [{ role: "user", content: prompt }],
								tools: [],
							}),
						});
					},
				});
				assertCurrent();
				const result = z
					.object({
						output_text: z.string().optional(),
						output: z
							.array(
								z.object({
									content: z
										.array(z.object({ text: z.string().optional() }))
										.optional(),
								}),
							)
							.optional(),
					})
					.parse(raw);
				const text =
					result.output_text ??
					(result.output ?? [])
						.flatMap((o) => o.content ?? [])
						.map((c) => c.text ?? "")
						.join("\n");
				if (!text || text.length > 300000)
					throw new Error("Podcast proposal is empty or too large");
				return text;
			} finally {
				clearTimeout(timeout);
			}
		};
		onStage(`מנוע עריכת פודקאסט · ${model}`);
		const videos = await runPodcastEditorial({
			source,
			options,
			ask: askRaw,
			assertCurrent,
			onStage,
			onResume,
			onReport,
			cache,
		});
		assertCurrent();
		review({ options, videos });
		return videos;
	} finally {
		signal.removeEventListener("abort", abort);
		window.removeEventListener("pagehide", abort);
	}
}
