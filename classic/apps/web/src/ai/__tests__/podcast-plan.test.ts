/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- isolated browser transport doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import { parsePodcastProposal, requestPodcastPlan } from "../podcast-plan";
import type { PodcastMode, PodcastVideo } from "../podcast-types";
const video: PodcastVideo = {
	title: "רעיון",
	openingHook: "שאלה",
	endingHook: "תשובה",
	confidence: 0.8,
	alternatives: [
		{
			label: "שלם",
			reason: "רעיון שלם",
			parts: [{ firstWord: 0, lastWord: 9 }],
		},
	],
};
const words = Array.from({ length: 30 }, (_, i) => ({
	id: i,
	sourceIndex: i,
	clipId: "clip",
	text: `מילה${i}`,
	start: i * 360000,
	end: i * 360000 + 120000,
}));
const source = { revision: 1, words, windows: [{ index: 0, words }] };
const originalFetch = globalThis.fetch,
	originalWindow = globalThis.window;
afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.window = originalWindow;
});
function browser() {
	globalThis.window = Object.assign(new EventTarget(), {
		__opencutAccountId: "test",
	}) as unknown as Window & typeof globalThis;
}
function stream(videos: PodcastVideo[]) {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], output_text: JSON.stringify({ videos }) } })}\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
for (const mode of ["highlights", "chronological"] as PodcastMode[]) {
	test(`${mode} analyzes windows then validates its output through the canonical reviewer`, async () => {
		browser();
		const requests: Record<string, unknown>[] = [];
		let reviews = 0;
		globalThis.fetch = mock(async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return requests.length === 1
				? Response.json({ models: [{ id: "test-model" }] })
				: stream([video]);
		}) as unknown as typeof fetch;
		const result = await requestPodcastPlan({
			source,
			options: { mode, minSeconds: 20, maxSeconds: 60, maxOutputs: 4 },
			signal: new AbortController().signal,
			onStage: () => {},
			review: () => {
				reviews++;
			},
		});
		expect(result).toEqual([video]);
		expect(requests).toHaveLength(3);
		expect(reviews).toBe(2);
		expect(JSON.stringify(requests[2])).toContain(
			mode === "teaser"
				? "unresolved question"
				: mode === "chronological"
					? "strictly increasing"
					: "THREE complete passages",
		);
		expect(requests[1].tools).toEqual([]);
	});
}
test("invalid candidates get one bounded repair, while an invalid final proposal never escapes", async () => {
	browser();
	let calls = 0,
		reviews = 0;
	globalThis.fetch = mock(async () =>
		++calls === 1
			? Response.json({ models: [{ id: "test" }] })
			: stream([video]),
	) as unknown as typeof fetch;
	await expect(
		requestPodcastPlan({
			source,
			options: {
				mode: "highlights",
				minSeconds: 20,
				maxSeconds: 60,
				maxOutputs: 1,
			},
			signal: new AbortController().signal,
			onStage: () => {},
			review: () => {
				reviews++;
				throw new Error("invalid chronology");
			},
		}),
	).rejects.toThrow("invalid chronology");
	expect(calls).toBe(3);
	expect(reviews).toBe(2);
});
test("account changes and cancellation cannot return a proposal", async () => {
	browser();
	globalThis.fetch = mock(async () => {
		window.__opencutAccountId = "other";
		return Response.json({ models: [{ id: "test" }] });
	}) as unknown as typeof fetch;
	await expect(
		requestPodcastPlan({
			source,
			options: {
				mode: "teaser",
				minSeconds: 20,
				maxSeconds: 60,
				maxOutputs: 1,
			},
			signal: new AbortController().signal,
			onStage: () => {},
			review: () => {
				throw new Error("must not review");
			},
		}),
	).rejects.toThrow("Account changed");
	const controller = new AbortController();
	controller.abort();
	await expect(
		requestPodcastPlan({
			source,
			options: {
				mode: "teaser",
				minSeconds: 20,
				maxSeconds: 60,
				maxOutputs: 1,
			},
			signal: controller.signal,
			onStage: () => {},
			review: () => {},
		}),
	).rejects.toThrow();
});
test("proposal parser rejects fabricated properties and malformed spans", () => {
	expect(parsePodcastProposal(JSON.stringify({ videos: [video] }))).toEqual([
		video,
	]);
	expect(() =>
		parsePodcastProposal(
			JSON.stringify({ videos: [{ ...video, script: "invented" }] }),
		),
	).toThrow();
	expect(() =>
		parsePodcastProposal('{"videos":[{"title":"only title"}]}'),
	).toThrow();
});

test("window analysis overlaps two requests, remains bounded and preserves source order", async () => {
	browser();
	let active = 0,
		peak = 0;
	const finished: number[] = [];
	let finalOrder: string[] = [];
	globalThis.fetch = mock(async (url, init) => {
		if (String(url).includes("connection"))
			return Response.json({ models: [{ id: "test" }] });
		const request = JSON.parse(String(init?.body));
		const prompt = JSON.parse(request.input[0].content);
		if (prompt.index !== undefined) {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) =>
				setTimeout(resolve, prompt.index === 0 ? 30 : 1),
			);
			active--;
			finished.push(prompt.index);
			return stream([{ ...video, title: `window-${prompt.index}` }]);
		}
		finalOrder = prompt.candidates.map((c: PodcastVideo) => c.title);
		return stream([video]);
	}) as unknown as typeof fetch;
	await requestPodcastPlan({
		source: {
			...source,
			windows: [0, 1, 2, 3].map((index) => ({ index, words })),
		},
		options: {
			mode: "highlights",
			minSeconds: 20,
			maxSeconds: 60,
			maxOutputs: 4,
		},
		signal: new AbortController().signal,
		onStage: () => {},
		review: () => {},
	});
	expect(peak).toBe(2);
	expect(finished[0]).toBe(1);
	expect(finalOrder).toEqual(["window-0", "window-1", "window-2", "window-3"]);
});

test("a failed later window resumes from reviewed checkpoints instead of requesting earlier windows again", async () => {
	browser();
	const data = new Map<string, string>();
	const cache = {
		key: "same-source",
		storage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => {
				data.set(k, v);
			},
			removeItem: (k: string) => {
				data.delete(k);
			},
		},
	};
	const requested: number[] = [];
	let fail = true;
	globalThis.fetch = mock(async (url, init) => {
		if (String(url).includes("connection"))
			return Response.json({ models: [{ id: "test" }] });
		const prompt = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
		if (prompt.index !== undefined) {
			requested.push(prompt.index);
			if (prompt.index === 2 && fail)
				return Response.json(
					{
						error:
							"Our servers are currently overloaded. Please try again later.",
					},
					{ status: 503 },
				);
			return stream([{ ...video, title: `window-${prompt.index}` }]);
		}
		return stream([video]);
	}) as unknown as typeof fetch;
	const input = {
		source: {
			...source,
			windows: [0, 1, 2].map((index) => ({ index, words })),
		},
		options: {
			mode: "highlights" as const,
			minSeconds: 20,
			maxSeconds: 60,
			maxOutputs: 4,
		},
		signal: new AbortController().signal,
		onStage: () => {},
		review: () => {},
		cache,
	};
	await expect(requestPodcastPlan(input)).rejects.toThrow("overloaded");
	expect(data.size).toBe(2);
	fail = false;
	expect(await requestPodcastPlan(input)).toEqual([video]);
	expect(requested).toEqual([0, 1, 2, 2]);
});

test("temporary provider stream failures use the native retry plan before any proposal escapes", async () => {
	browser();
	let asks = 0;
	const retries: string[] = [];
	const failures: unknown[] = [];
	globalThis.fetch = mock(async (url) => {
		if (String(url).includes("connection"))
			return Response.json({ models: [{ id: "test" }] });
		if (++asks === 1)
			return new Response(
				`data: ${JSON.stringify({ type: "error", error: { code: "overloaded", message: "Our servers are currently overloaded. Please try again later." } })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		return stream([video]);
	}) as unknown as typeof fetch;
	const result = await requestPodcastPlan({
		source,
		options: {
			mode: "highlights",
			minSeconds: 20,
			maxSeconds: 60,
			maxOutputs: 4,
		},
		signal: new AbortController().signal,
		onStage: (stage) => {
			if (stage.includes("retrying")) retries.push(stage);
		},
		review: () => {},
		planRetry: (failure) => {
			failures.push(failure);
			return { retry: failure.attempt < 2, delayMs: 0, maxAttempts: 2 };
		},
	});
	expect(result).toEqual([video]);
	expect(asks).toBe(3);
	expect(retries).toHaveLength(1);
	expect(failures[0]).toMatchObject({
		kind: "providerFailure",
		code: "overloaded",
		responseApplied: false,
	});
});
