/* eslint-disable opencut/prefer-object-params -- Platform test doubles. */
import { expect, mock, test } from "bun:test";
import type { TranscriptionResult } from "./types";
let calls = 0;
let failAt = Infinity;
let range = { start: 0, end: 0 };
mock.module("@/services/transcription/service", () => ({
	transcriptionService: {
		withChunkSession: async ({
			signal,
			run,
		}: Parameters<
			import("@/services/transcription/service").TranscriptionService["withChunkSession"]
		>[0]) =>
			run(async ({ load }) => {
				await load();
				if (++calls === failAt) throw new Error("GPU reset");
				const words = [];
				for (let t = range.start; t + 1 < range.end; t += 2)
					words.push({
						text: `word-${t}`,
						start: t - range.start,
						end: t - range.start + 1,
					});
				return { text: "", words, segments: words, language: "en" };
			}, signal),
	},
}));
const { transcribeAudioWindows } = await import("./windows");

test("three-hour input is decoded in at most 70-second windows with ordered absolute times", async () => {
	calls = 0;
	failAt = Infinity;
	let largest = 0;
	const progress: number[] = [];
	const result = await transcribeAudioWindows({
		prefetch: false,
		duration: 10800,
		signal: new AbortController().signal,
		language: "en",
		load: async (r) => {
			range = r;
			largest = Math.max(largest, r.end - r.start);
			return new Float32Array(Math.ceil((r.end - r.start) * 16000));
		},
		onProgress: (p) => progress.push(p.progress),
	});
	expect(calls).toBe(180);
	expect(largest).toBe(70);
	expect(result.words!.at(-1)!.end).toBeGreaterThan(10795);
	for (let i = 1; i < result.words!.length; i++)
		expect(result.words![i].start).toBeGreaterThanOrEqual(
			result.words![i - 1].end,
		);
	expect(progress.at(-1)).toBe(100);
});

test("a late failure resumes completed sections without decoding or inferring them again", async () => {
	calls = 0;
	failAt = 3;
	const results = new Map<number, TranscriptionResult>();
	const loads: number[] = [];
	const input = {
		prefetch: false,
		duration: 185,
		signal: new AbortController().signal,
		language: "en" as const,
		load: async (r: { start: number; end: number }) => {
			range = r;
			loads.push(r.start);
			return new Float32Array(1);
		},
		cache: {
			read: async (i: number) => results.get(i),
			write: async (i: number, r: TranscriptionResult) => {
				results.set(i, r);
			},
		},
	};
	await expect(transcribeAudioWindows(input)).rejects.toThrow("GPU reset");
	expect(results.size).toBe(2);
	loads.length = 0;
	failAt = Infinity;
	const result = await transcribeAudioWindows(input);
	expect(loads).toEqual([115, 175]);
	expect(results.size).toBe(4);
	expect(result.words![0].start).toBe(0);
	expect(result.words!.at(-1)!.end).toBeGreaterThan(180);
});

test("cancelling after a saved section prevents subsequent decode", async () => {
	calls = 0;
	failAt = Infinity;
	const controller = new AbortController();
	await expect(
		transcribeAudioWindows({
			prefetch: false,
			duration: 10800,
			language: "en",
			signal: controller.signal,
			load: async (r) => {
				range = r;
				return new Float32Array(1);
			},
			onProgress: () => controller.abort(),
		}),
	).rejects.toHaveProperty("name", "AbortError");
	expect(calls).toBe(1);
});

test("each checkpoint finishes before decoding the next window; durable words bypass inference", async () => {
	calls = 0;
	failAt = Infinity;
	const completed: Record<string, import("./types").TranscriptionWord[]> = {
		"0": [{ text: "persisted", start: 1, end: 2 }],
		"1": [],
	};
	const events: string[] = [];
	await transcribeAudioWindows({
		prefetch: false,
		duration: 185,
		language: "en",
		signal: new AbortController().signal,
		completedChunks: completed,
		load: async (r) => {
			range = r;
			events.push(`load:${r.start}`);
			return new Float32Array(1);
		},
		onChunk: async ({ index, words }) => {
			events.push(`save:${index}`);
			await Promise.resolve();
			completed[index] = words;
			events.push(`saved:${index}`);
		},
	});
	expect(calls).toBe(2);
	expect(events).toEqual([
		"save:0",
		"saved:0",
		"save:1",
		"saved:1",
		"load:115",
		"save:2",
		"saved:2",
		"load:175",
		"save:3",
		"saved:3",
	]);
	expect(completed["0"][0].text).toBe("persisted");
});

test("publication failure never advances decoding and retries from cached provider text", async () => {
	calls = 0;
	failAt = Infinity;
	const cache = new Map<number, TranscriptionResult>();
	let failing = true;
	const input = {
		prefetch: false,
		duration: 125,
		language: "en" as const,
		signal: new AbortController().signal,
		load: async (r: { start: number; end: number }) => {
			range = r;
			return new Float32Array(1);
		},
		cache: {
			read: async (i: number) => cache.get(i),
			write: async (i: number, result: TranscriptionResult) => {
				cache.set(i, result);
				return true;
			},
		},
		onChunk: async ({ index }: { index: number }) => {
			if (index === 0 && failing) throw new Error("disk unavailable");
		},
	};
	await expect(transcribeAudioWindows(input)).rejects.toThrow(
		"disk unavailable",
	);
	expect(calls).toBe(1);
	failing = false;
	await transcribeAudioWindows(input);
	expect(calls).toBe(3);
});

test("external engine bypasses the local model while retaining checkpoints and ownership windows", async () => {
	calls = 0;
	failAt = Infinity;
	const published: number[] = [];
	let externalCalls = 0;
	await transcribeAudioWindows({
		prefetch: false,
		duration: 125,
		language: "en",
		signal: new AbortController().signal,
		completedChunks: { "0": [{ text: "saved", start: 1, end: 2 }] },
		load: async (r) => {
			range = r;
			return new Float32Array(16);
		},
		externalTranscribe: async ({ load }) => {
			await load();
			externalCalls++;
			return {
				text: "API",
				segments: [],
				words: [{ text: "API", start: 6, end: 7 }],
				language: "en",
			};
		},
		onChunk: async ({ index }) => {
			published.push(index);
		},
	});
	expect(calls).toBe(0);
	expect(externalCalls).toBe(2);
	expect(published).toEqual([0, 1, 2]);
});

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
test("two provider windows overlap, decode stays serial, publication remains ordered", async () => {
	const gates = [deferred(), deferred()];
	const started = deferred();
	let active = 0,
		maximum = 0,
		decoding = 0,
		calls = 0;
	const published: number[] = [];
	const pending = transcribeAudioWindows({
		duration: 120,
		language: "he",
		signal: new AbortController().signal,
		load: async () => {
			expect(++decoding).toBe(1);
			await Promise.resolve();
			decoding--;
			return new Float32Array(1);
		},
		externalTranscribe: async ({ load }) => {
			await load();
			const i = calls++;
			maximum = Math.max(maximum, ++active);
			if (calls === 2) started.resolve();
			await gates[i].promise;
			active--;
			return { text: "", words: [], segments: [], language: "he" };
		},
		onChunk: async ({ index }) => {
			published.push(index);
		},
	});
	await started.promise;
	gates[1].resolve();
	await Promise.resolve();
	expect(published).toEqual([]);
	gates[0].resolve();
	await pending;
	expect(maximum).toBe(2);
	expect(published).toEqual([0, 1]);
});
test("prefetch decodes ahead while inference waits; failure aborts siblings without publishing", async () => {
	const began = deferred(),
		decoded = deferred(),
		siblingsReady = deferred();
	let loads = 0;
	let siblingAborted = false;
	let startedCalls = 0;
	const pending = transcribeAudioWindows({
		duration: 240,
		language: "he",
		signal: new AbortController().signal,
		load: async () => {
			if (++loads === 3) decoded.resolve();
			return new Float32Array(1);
		},
		externalTranscribe: async ({ load, signal }) => {
			await load();
			if (startedCalls++ === 0) {
				await began.promise;
				throw new Error("provider failed");
			}
			siblingsReady.resolve();
			return new Promise((_, reject) =>
				signal!.addEventListener(
					"abort",
					() => {
						siblingAborted = true;
						reject(signal!.reason);
					},
					{ once: true },
				),
			);
		},
		onChunk: async () => {
			throw new Error("must not publish");
		},
	});
	void pending.catch(() => {});
	await decoded.promise;
	await siblingsReady.promise;
	began.resolve();
	await expect(pending).rejects.toThrow("provider failed");
	expect(loads).toBeLessThanOrEqual(4);
	expect(siblingAborted).toBe(true);
});
