import { expect, test } from "bun:test";
import {
	runPodcastEditorial,
	consumePodcastEditorialDraft,
} from "../podcast-editorial";
import type { PodcastEditorialStep, PodcastSource } from "../podcast-types";
const options = {
	mode: "teaser" as const,
	minSeconds: 45,
	maxSeconds: 60,
	maxOutputs: 1,
};
const video = {
	title: "test",
	openingHook: "hook",
	endingHook: "question",
	confidence: 0.9,
	alternatives: [
		{
			label: "first",
			reason: "coherent",
			parts: [{ firstWord: 0, lastWord: 10 }],
		},
	],
};
const job = (key: string) => ({
	key,
	stage: "inventory",
	instructions: "Canonical request",
	prompt: { key },
});
function step(
	requests: ReturnType<typeof job>[],
	complete = false,
): PodcastEditorialStep {
	return {
		policyVersion: "strategic-teaser-v1",
		complete,
		requests,
		videos: complete ? [video] : [],
		report: { windowsReviewed: complete ? 2 : 0, windowsTotal: 2 },
	};
}
function cache() {
	const data = new Map<string, string>();
	return {
		key: "source-policy-digest",
		storage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => {
				data.set(k, v);
			},
			removeItem: (k: string) => {
				data.delete(k);
			},
		},
		data,
	};
}
test("a successful sibling checkpoints immediately and resumes after provider failure", async () => {
	const saved = cache();
	let fail = true;
	const resumed: number[] = [];
	const asked: string[] = [];
	const source: PodcastSource = {
		revision: 1,
		words: [],
		windows: [],
		editorial: ({ responses }) => {
			const missing = ["inventory:0:0", "inventory:1:0"].filter(
				(key) => !responses[key],
			);
			return step(missing.map(job), missing.length === 0);
		},
	};
	const ask = async ({ prompt }: { prompt: string; instructions: string }) => {
		const { key } = JSON.parse(prompt);
		asked.push(key);
		if (key === "inventory:1:0" && fail) throw Error("overloaded");
		return JSON.stringify({ summary: "observed", candidates: [] });
	};
	const input = {
		source,
		options,
		ask,
		assertCurrent: () => {},
		onStage: () => {},
		cache: saved,
		onResume: (count: number) => {
			resumed.push(count);
		},
	};
	await expect(runPodcastEditorial(input)).rejects.toThrow("overloaded");
	expect(
		JSON.parse(saved.data.get(`${saved.key}:editorial-v1`)!).responses[
			"inventory:0:0"
		],
	).toBeDefined();
	fail = false;
	expect(await runPodcastEditorial(input)).toEqual([video]);
	expect(asked).toEqual(["inventory:0:0", "inventory:1:0", "inventory:1:0"]);
	expect(saved.data.has(`${saved.key}:editorial-v1:report`)).toBe(true);
	expect(
		await runPodcastEditorial({
			...input,
			ask: async () => {
				throw Error("Completed analysis was replayed");
			},
		}),
	).toEqual([video]);
	expect(resumed).toEqual([1, 2]);
});
test("malformed JSON is evidence for canonical repair, never silently accepted", async () => {
	let observed: unknown;
	const source: PodcastSource = {
		revision: 1,
		words: [],
		windows: [],
		editorial: ({ responses }) => {
			if (!responses.first) return step([job("first")]);
			observed = responses.first;
			return step([], true);
		},
	};
	await runPodcastEditorial({
		source,
		options,
		ask: async () => "not JSON",
		assertCurrent: () => {},
		onStage: () => {},
	});
	expect(observed).toEqual({ invalidJson: "not JSON" });
});
test("scope loss while a provider responds never checkpoints or returns a result", async () => {
	const saved = cache();
	let current = true;
	const source: PodcastSource = {
		revision: 1,
		words: [],
		windows: [],
		editorial: () => step([job("first")]),
	};
	await expect(
		runPodcastEditorial({
			source,
			options,
			cache: saved,
			ask: async () => {
				current = false;
				return "{}";
			},
			assertCurrent: () => {
				if (!current) throw Error("source changed");
			},
			onStage: () => {},
		}),
	).rejects.toThrow("source changed");
	expect(saved.data.size).toBe(0);
});
test("missing canonical policy fails safely instead of the old single-excerpt fallback", async () => {
	await expect(
		runPodcastEditorial({
			source: { revision: 1, words: [], windows: [] },
			options,
			ask: async () => {
				throw Error("must not infer");
			},
			assertCurrent: () => {},
			onStage: () => {},
		}),
	).rejects.toThrow("Reload OpenCut");
});

test("terminal rejection resets only canonical failed artifacts and retains reviewed inventory", async () => {
	const saved = cache();
	saved.data.set(
		`${saved.key}:editorial-v1`,
		JSON.stringify({
			version: 1,
			responses: {
				"inventory:0:0": { summary: "valid" },
				"draft:0": { bad: true },
			},
		}),
	);
	const source: PodcastSource = {
		revision: 1,
		words: [],
		windows: [],
		editorial: () => ({
			...step([]),
			report: { error: "Narrative rejected", resetKeys: ["draft:0"] },
		}),
	};
	await expect(
		runPodcastEditorial({
			source,
			options,
			cache: saved,
			ask: async () => {
				throw Error("must not call");
			},
			assertCurrent: () => {},
			onStage: () => {},
		}),
	).rejects.toThrow("Narrative rejected");
	const responses = JSON.parse(
		saved.data.get(`${saved.key}:editorial-v1`)!,
	).responses;
	expect(responses["inventory:0:0"]).toBeDefined();
	expect(responses["draft:0"]).toBeUndefined();
	const failure = JSON.parse(
		saved.data.get(`${saved.key}:editorial-v1:failure`)!,
	);
	expect(failure.responses["draft:0"]).toEqual({ bad: true });
	expect(failure.report.error).toBe("Narrative rejected");
});
test("canonical failure details reach task status even if optional forensic storage is full", async () => {
	const reports: Record<string, unknown>[] = [];
	const saved = cache();
	const report = {
		error: "Missing words 800..815",
		failures: [
			{ round: 2, stage: "validation", reason: "Missing words 800..815" },
		],
	};
	await expect(
		runPodcastEditorial({
			source: {
				revision: 1,
				words: [],
				windows: [],
				editorial: () => ({ ...step([]), report }),
			},
			options,
			cache: {
				...saved,
				storage: {
					...saved.storage,
					setItem: () => {
						throw Error("quota");
					},
				},
			},
			ask: async () => {
				throw Error("must not infer");
			},
			assertCurrent: () => {},
			onStage: () => {},
			onReport: (r) => {
				reports.push(r);
			},
		}),
	).rejects.toThrow("Missing words 800..815");
	expect(reports).toEqual([report]);
});
test("a saved output consumes its narrative so the next run can compose anew without rescanning", () => {
	const saved = cache();
	saved.data.set(
		`${saved.key}:editorial-v1`,
		JSON.stringify({
			version: 1,
			responses: {
				"inventory:0:0": {},
				"draft:0": {},
				"critique:0": {},
				"draft:0:context": {},
			},
		}),
	);
	consumePodcastEditorialDraft({ storage: saved.storage, key: saved.key });
	expect(
		Object.keys(
			JSON.parse(saved.data.get(`${saved.key}:editorial-v1`)!).responses,
		),
	).toEqual(["inventory:0:0"]);
});

test("teleprompter checkpoints resume per-line alternatives without flattening or using short-form policy", async () => {
	const saved = cache();
	const teleOptions = {
		mode: "teleprompter" as const,
		minSeconds: 0,
		maxSeconds: 0,
		maxOutputs: 32,
	};
	const teleVideo = {
		...video,
		alternatives: [],
		groups: [
			{
				label: "שלום לכולם",
				confidence: 0.9,
				selected: 1,
				alternatives: [
					...video.alternatives,
					{
						label: "קריאה שנייה",
						reason: "משפט שלם",
						parts: [{ firstWord: 11, lastWord: 23 }],
					},
				],
			},
		],
		discarded: [],
	};
	let stop = true;
	const source: PodcastSource = {
		revision: 1,
		words: [],
		windows: [],
		editorial: ({ responses }) => ({
			policyVersion: "teleprompter-v4",
			complete: !!responses["draft:0"],
			requests: responses["draft:0"]
				? []
				: [job("inventory:0:0"), job("draft:0")].filter(
						(j) => !responses[j.key],
					),
			videos: responses["draft:0"] ? [teleVideo] : [],
			report: {},
		}),
	};
	const asked: string[] = [];
	const input = {
		source,
		options: teleOptions,
		cache: saved,
		assertCurrent: () => {},
		onStage: () => {},
		ask: async ({ prompt }: { prompt: string }) => {
			const { key } = JSON.parse(prompt);
			asked.push(key);
			if (key === "draft:0" && stop) throw Error("interrupted");
			return JSON.stringify({ saved: true });
		},
	};
	await expect(runPodcastEditorial(input)).rejects.toThrow("interrupted");
	stop = false;
	expect(await runPodcastEditorial(input)).toEqual([teleVideo]);
	expect(asked.filter((k) => k === "inventory:0:0")).toHaveLength(1);
	expect(asked.filter((k) => k === "draft:0")).toHaveLength(2);
});
test("v4 resumes old exhausted drafts and reviews once instead of repeating finished provider work", async () => {
	const saved = cache();
	saved.data.set(
		`${saved.key}:editorial-v1`,
		JSON.stringify({
			version: 1,
			responses: { "inventory:0:0": { valid: true } },
		}),
	);
	saved.data.set(
		`${saved.key}:editorial-v1:failure`,
		JSON.stringify({
			version: 1,
			responses: {
				"inventory:0:0": { valid: true },
				"draft:2": { repair: true },
				"critique:2:0": { cleanCuts: false },
			},
		}),
	);
	let observed: Record<string, unknown> = {};
	await runPodcastEditorial({
		source: {
			revision: 1,
			words: [],
			windows: [],
			editorial: ({ responses }) => {
				observed = responses;
				return { ...step([], true), policyVersion: "teleprompter-v4" };
			},
		},
		options: {
			mode: "teleprompter",
			minSeconds: 0,
			maxSeconds: 0,
			maxOutputs: 32,
		},
		cache: saved,
		ask: async () => {
			throw Error("must not redo provider work");
		},
		assertCurrent: () => {},
		onStage: () => {},
	});
	expect(observed["draft:2"]).toEqual({ repair: true });
	expect(observed["critique:2:0"]).toEqual({ cleanCuts: false });
	expect(saved.data.has(`${saved.key}:editorial-v1:failure`)).toBe(false);
});
