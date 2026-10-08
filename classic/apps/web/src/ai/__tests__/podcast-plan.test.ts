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
for (const mode of ["teaser", "highlights", "chronological"] as PodcastMode[]) {
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
				mode: "teaser",
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
