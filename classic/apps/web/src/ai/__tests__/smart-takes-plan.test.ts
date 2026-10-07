/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- isolated browser/transport test doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import { parseSmartTakePlan, requestSmartTakePlan } from "../smart-takes-plan";
const plan = {
	groups: [
		{
			label: "פתיחה",
			confidence: 0.8,
			selected: 0,
			alternatives: [
				{
					label: "טייק",
					reason: "משפט שלם",
					parts: [{ firstWord: 0, lastWord: 0 }],
				},
			],
		},
	],
	discarded: [],
};
const words = [
	{
		id: 0,
		sourceIndex: 0,
		clipId: "clip",
		text: "שלום",
		start: 0,
		end: 120000,
	},
];
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.window = originalWindow;
});
function windowStub() {
	const target = new EventTarget();
	globalThis.window = Object.assign(target, {
		__opencutAccountId: "account",
	}) as unknown as Window & typeof globalThis;
}
function stream(text: string) {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output_text: text, output: [] } })}\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
test("three inference stages carry global evidence and the draft into critique", async () => {
	windowStub();
	const requests: Record<string, unknown>[] = [];
	const stages: string[] = [];
	globalThis.fetch = mock(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		return requests.length === 1
			? Response.json({ models: [{ id: "test-model" }] })
			: stream(
					requests.length === 2
						? "A complete opening, no notes."
						: JSON.stringify(plan),
				);
	}) as unknown as typeof fetch;
	expect(
		await requestSmartTakePlan({
			words,
			signal: new AbortController().signal,
			onStage: (stage) => stages.push(stage),
		}),
	).toEqual(plan);
	expect(stages).toHaveLength(3);
	expect(requests).toHaveLength(4);
	expect(JSON.stringify(requests[3])).toContain("Proposed plan");
	expect(JSON.stringify(requests[3])).toContain("שלום");
	expect(requests[1].tools).toEqual([]);
});
test("account changes stop the pipeline before a proposal can escape", async () => {
	windowStub();
	let requests = 0;
	globalThis.fetch = mock(async () => {
		requests++;
		window.__opencutAccountId = "changed";
		return Response.json({ models: [{ id: "model" }] });
	}) as unknown as typeof fetch;
	await expect(
		requestSmartTakePlan({
			words,
			signal: new AbortController().signal,
			onStage: () => {},
		}),
	).rejects.toThrow("Account changed");
	expect(requests).toBe(1);
});
test("cancellation between stages stops further requests", async () => {
	windowStub();
	const controller = new AbortController();
	let requests = 0;
	globalThis.fetch = mock(async () => {
		requests++;
		return requests === 1
			? Response.json({ models: [{ id: "model" }] })
			: stream("analysis");
	}) as unknown as typeof fetch;
	await expect(
		requestSmartTakePlan({
			words,
			signal: controller.signal,
			onStage: (stage) => {
				if (stage.startsWith("2/")) controller.abort();
			},
		}),
	).rejects.toThrow();
	expect(requests).toBe(2);
});
test("malformed output, tool-shaped content and invalid confidence are rejected", () => {
	expect(() => parseSmartTakePlan("No plan")).toThrow();
	expect(() => parseSmartTakePlan('{"tool":"deleteEverything"}')).toThrow();
	expect(() =>
		parseSmartTakePlan(
			JSON.stringify({
				...plan,
				groups: [{ ...plan.groups[0], confidence: 3 }],
			}),
		),
	).toThrow();
	expect(
		parseSmartTakePlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``),
	).toEqual(plan);
});
test("a completed checkpoint retries apply without another provider request", async () => {
	windowStub();
	globalThis.fetch = mock(() => {
		throw new Error("Unexpected network request");
	}) as unknown as typeof fetch;
	expect(
		await requestSmartTakePlan({
			words,
			signal: new AbortController().signal,
			onStage: () => {},
			checkpoint: { plan },
		}),
	).toEqual(plan);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});
test("a saved draft resumes only the continuity pass", async () => {
	windowStub();
	const prompts: string[] = [];
	globalThis.fetch = mock(async (_url, init) => {
		prompts.push(String(init?.body));
		return prompts.length === 1
			? Response.json({ models: [{ id: "model" }] })
			: stream(JSON.stringify(plan));
	}) as unknown as typeof fetch;
	const checkpoints: unknown[] = [];
	await requestSmartTakePlan({
		words,
		signal: new AbortController().signal,
		onStage: () => {},
		checkpoint: { analysis: "saved analysis", draft: plan },
		onCheckpoint: (value) => checkpoints.push(value),
	});
	expect(prompts).toHaveLength(2);
	expect(prompts[1]).toContain("Proposed plan");
	expect(checkpoints.at(-1)).toEqual({
		analysis: "saved analysis",
		draft: plan,
		plan,
	});
});
test("a cancelled request cannot return a cached final plan", async () => {
	windowStub();
	const controller = new AbortController();
	controller.abort();
	await expect(
		requestSmartTakePlan({
			words,
			signal: controller.signal,
			onStage: () => {},
			checkpoint: { plan },
		}),
	).rejects.toThrow();
});
