/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- isolated browser transport doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import { parsePodcastProposal, requestPodcastPlan } from "../podcast-plan";
import type {
	PodcastMode,
	PodcastSource,
	PodcastVideo,
} from "../podcast-types";
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
function stream(value: unknown) {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], output_text: JSON.stringify(value) } })}\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
function source(mode: PodcastMode): PodcastSource {
	return {
		revision: 1,
		words: [],
		windows: [],
		editorial: ({ responses }) => {
			const missing = ["inventory:0:0", "inventory:1:0"].filter(
				(k) => !responses[k],
			);
			const stage = missing.length
				? "inventory"
				: !responses["draft:0"]
					? "compose"
					: !responses["critique:0:0"]
						? "critique"
						: null;
			const keys = missing.length
				? missing
				: stage === "compose"
					? ["draft:0"]
					: stage === "critique"
						? ["critique:0:0"]
						: [];
			return {
				policyVersion:
					mode === "teaser" ? "strategic-teaser-v1" : "podcast-shorts-v2",
				complete: !stage,
				requests: keys.map((key) => ({
					key,
					stage: stage!,
					instructions: `Canonical ${mode} ${stage}`,
					prompt: { key },
				})),
				videos: stage ? [] : [video],
				report: {},
			};
		},
	};
}
const options = (mode: PodcastMode) => ({
	mode,
	minSeconds: 20,
	maxSeconds: 60,
	maxOutputs: 4,
});
function cache() {
	const data = new Map<string, string>();
	return {
		key: "same-source",
		data,
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
}
for (const mode of ["teaser", "highlights", "chronological"] as PodcastMode[]) {
	test(`${mode} delegates mapping, composition and critique to canonical workflow before final validation`, async () => {
		browser();
		const requests: Record<string, unknown>[] = [];
		let reviews = 0;
		let providerRequests = 0;
		globalThis.fetch = mock(async (url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			return String(url).includes("connection")
				? Response.json({ models: [{ id: "test-model" }] })
				: stream({ reviewed: true });
		}) as unknown as typeof fetch;
		const result = await requestPodcastPlan({
			onProviderRequest: () => {
				providerRequests++;
			},
			source: source(mode),
			options: options(mode),
			signal: new AbortController().signal,
			onStage: () => {},
			review: () => {
				reviews++;
			},
		});
		expect(result).toEqual([video]);
		expect(requests).toHaveLength(5);
		expect(providerRequests).toBe(4);
		expect(reviews).toBe(1);
		expect(requests.slice(1).map((r) => r.instructions)).toEqual([
			`Canonical ${mode} inventory`,
			`Canonical ${mode} inventory`,
			`Canonical ${mode} compose`,
			`Canonical ${mode} critique`,
		]);
		expect(requests[1].tools).toEqual([]);
	});
}
test("a technically rejected completed plan never escapes the transport", async () => {
	browser();
	globalThis.fetch = mock(async () =>
		Response.json({ models: [{ id: "test" }] }),
	) as unknown as typeof fetch;
	const s = source("highlights");
	s.editorial = () => ({
		policyVersion: "podcast-shorts-v2",
		complete: true,
		requests: [],
		videos: [video],
		report: {},
	});
	await expect(
		requestPodcastPlan({
			source: s,
			options: options("highlights"),
			signal: new AbortController().signal,
			onStage: () => {},
			review: () => {
				throw Error("invalid chronology");
			},
		}),
	).rejects.toThrow("invalid chronology");
});
test("account changes and cancellation cannot return a proposal", async () => {
	browser();
	globalThis.fetch = mock(async () => {
		window.__opencutAccountId = "other";
		return Response.json({ models: [{ id: "test" }] });
	}) as unknown as typeof fetch;
	const input = {
		source: source("highlights"),
		options: options("highlights"),
		signal: new AbortController().signal,
		onStage: () => {},
		review: () => {
			throw Error("must not review");
		},
	};
	await expect(requestPodcastPlan(input)).rejects.toThrow("Account changed");
	const controller = new AbortController();
	controller.abort();
	await expect(
		requestPodcastPlan({ ...input, signal: controller.signal }),
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
test("both source requests overlap but remain bounded; failed sibling resumes without replaying successful work", async () => {
	browser();
	let active = 0,
		peak = 0,
		fail = true;
	const asked: string[] = [];
	const saved = cache();
	globalThis.fetch = mock(async (url, init) => {
		if (String(url).includes("connection"))
			return Response.json({ models: [{ id: "test" }] });
		const { key } = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
		asked.push(key);
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, key === "inventory:0:0" ? 10 : 1));
		active--;
		if (key === "inventory:1:0" && fail)
			return Response.json(
				{
					error:
						"Our servers are currently overloaded. Please try again later.",
				},
				{ status: 503 },
			);
		return stream({ reviewed: true });
	}) as unknown as typeof fetch;
	const input = {
		source: source("chronological"),
		options: options("chronological"),
		signal: new AbortController().signal,
		onStage: () => {},
		review: () => {},
		cache: saved,
	};
	await expect(requestPodcastPlan(input)).rejects.toThrow("overloaded");
	expect(peak).toBe(2);
	expect(
		JSON.parse(saved.data.get(`${saved.key}:editorial-v1`)!).responses[
			"inventory:0:0"
		],
	).toBeDefined();
	fail = false;
	expect(await requestPodcastPlan(input)).toEqual([video]);
	expect(asked).toEqual([
		"inventory:0:0",
		"inventory:1:0",
		"inventory:1:0",
		"draft:0",
		"critique:0:0",
	]);
});
test("temporary provider stream failure uses native retry policy without losing completed stages", async () => {
	browser();
	let asks = 0;
	const failures: unknown[] = [];
	globalThis.fetch = mock(async (url) => {
		if (String(url).includes("connection"))
			return Response.json({ models: [{ id: "test" }] });
		if (++asks === 1)
			return new Response(
				`data: ${JSON.stringify({ type: "error", error: { code: "overloaded", message: "Our servers are currently overloaded. Please try again later." } })}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		return stream({ reviewed: true });
	}) as unknown as typeof fetch;
	const result = await requestPodcastPlan({
		source: source("highlights"),
		options: options("highlights"),
		signal: new AbortController().signal,
		onStage: () => {},
		review: () => {},
		planRetry: (failure) => {
			failures.push(failure);
			return { retry: failure.attempt < 2, delayMs: 0, maxAttempts: 2 };
		},
	});
	expect(result).toEqual([video]);
	expect(asks).toBe(5);
	expect(failures[0]).toMatchObject({
		kind: "providerFailure",
		code: "overloaded",
		responseApplied: false,
	});
});
