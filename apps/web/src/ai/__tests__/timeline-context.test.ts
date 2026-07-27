import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import type { MediaTime } from "@/wasm";
import {
	buildTimelineContextIndex,
	buildTimelineDocument,
	getElementsInRange,
	getLayersInRange,
	rangesOverlap,
	searchElements,
	searchLayers,
} from "@/ai/timeline-context";
import type { EditorCore } from "@/core";

function canonicalizeTimelineSourceDocumentForTest({ json }: { json: string }) {
	try {
		const formattedJson = `${JSON.stringify(JSON.parse(json), null, 2)}\n`;
		let hash = 2_166_136_261;
		for (let index = 0; index < formattedJson.length; index += 1) {
			hash = Math.imul(hash ^ formattedJson.charCodeAt(index), 16_777_619);
		}
		return {
			valid: true,
			formattedJson,
			baseRevision: `mock-sha256:${(hash >>> 0).toString(16)}`,
			diagnostics: [],
		};
	} catch {
		return {
			valid: false,
			formattedJson: "",
			baseRevision: "",
			diagnostics: [
				{ code: "invalid_json", path: "$", message: "Invalid JSON" },
			],
		};
	}
}

function validateTimelineSourceV2MutationScopeForTest({
	beforeJson,
	afterJson,
	selectedRange,
}: {
	beforeJson: string;
	afterJson: string;
	selectedRange?: { startTime: number; duration: number };
}) {
	if (!selectedRange) return { valid: true, diagnostics: [] };
	type Element = { id: string; startTime: number; duration: number };
	type Document = { scene: { tracks: Array<{ elements: Element[] }> } };
	const collect = (document: Document) =>
		new Map(
			document.scene.tracks.flatMap((track) =>
				track.elements.map((element) => [element.id, element] as const),
			),
		);
	const before = collect(JSON.parse(beforeJson) as Document);
	const after = collect(JSON.parse(afterJson) as Document);
	const rangeEnd = selectedRange.startTime + selectedRange.duration;
	const diagnostics: Array<{ code: string; path: string; message: string }> =
		[];
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		const oldElement = before.get(id);
		const newElement = after.get(id);
		if (JSON.stringify(oldElement) === JSON.stringify(newElement)) continue;
		if (
			[oldElement, newElement].some(
				(element) =>
					element &&
					(element.startTime < selectedRange.startTime ||
						element.startTime + element.duration > rangeEnd),
			)
		) {
			diagnostics.push({
				code: "range_element_out_of_scope",
				path: "$.scene.tracks",
				message: `Element "${id}" was changed outside the selected range`,
			});
		}
	}
	return { valid: diagnostics.length === 0, diagnostics };
}

mock.module("opencut-wasm", () => ({
	initCompositor: () => undefined,
	getCompositorCanvas: () => null,
	getLastFrameProfile: () => null,
	releaseTexture: () => undefined,
	renderFrame: () => undefined,
	resizeCompositor: () => undefined,
	uploadTexture: () => undefined,
	applyEffectPasses: ({ source }: { source: unknown }) => source,
	applyMaskFeather: ({ mask }: { mask: unknown }) => mask,
	initializeGpu: async () => undefined,
	refineBackgroundAlpha: () => undefined,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	formatTimecode: () => "00:00:00:00",
	TICKS_PER_SECOND: 120_000,
	normalizeTextLayerWordIds: <T extends { wordRuns: Array<{ id: string }> }>(
		options: T,
	) =>
		options.wordRuns.map((word, previousWordIndex) => ({
			previousWordIndex,
			id: word.id,
		})),
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	reconcileTextContentWords: () => [],
	fitTextLayerWordsToSpan: () => [],
	textLayerDurationForWords: <
		T extends {
			duration: number;
			wordRuns: Array<{ startTime?: number; endTime?: number }>;
		},
	>(
		options: T,
	) =>
		Math.max(
			options.duration,
			...options.wordRuns.map((word) => word.endTime ?? word.startTime ?? 0),
		),
	defaultBackgroundRemovalSettings: () => ({
		enabled: false,
		mode: "remove",
		quality: "balanced",
		maskThreshold: 0.5,
		edgeContrast: 1,
		edgeFeather: 0,
		temporalSmoothing: 0,
		blurStrength: 0,
	}),
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({ clips: options.clips, timelineDuration: 0 }),
	planBackgroundRemovalDuplicate: () => ({
		kind: "existingTrack",
		trackId: "video",
	}),
	resolveBackgroundRemovalSettings: <T>(settings: T) => ({
		...settings,
		inputSize: 256,
		previewFps: 15,
		cacheEntries: 2,
		blurSigma: 0,
	}),
	searchAgentTools: ({
		tools,
		limit,
	}: {
		tools: Array<{ name: string }>;
		limit: number;
	}) =>
		tools.slice(0, limit).map((tool, index) => ({
			name: tool.name,
			score: 1 - index / Math.max(1, limit),
		})),
	planAgentRangePreviewFrames: ({
		startTime,
		endTime,
		maxFrames = 4,
	}: {
		startTime: number;
		endTime: number;
		maxFrames?: number;
	}) => ({
		valid: true,
		times: Array.from(
			{ length: Math.max(2, Math.min(4, Math.floor(maxFrames))) },
			(_, index, values) =>
				Math.round(
					startTime + ((endTime - startTime) * (index + 0.5)) / values.length,
				),
		),
	}),
	canonicalizeTimelineSourceDocument: canonicalizeTimelineSourceDocumentForTest,
	validateTimelineSourceV2MutationScope:
		validateTimelineSourceV2MutationScopeForTest,
}));

let buildTimelineContextPrompt: typeof import("@/ai/timeline-tools").buildTimelineContextPrompt;

beforeAll(async () => {
	({ buildTimelineContextPrompt } = await import("@/ai/timeline-tools"));
});

const t = (time: number) => {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixtures use integer ticks.
	return time as MediaTime;
};

const tracks: SceneTracks = {
	overlay: [
		{
			id: "text-track",
			name: "Captions",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "word-1",
					type: "text",
					name: "hello",
					startTime: t(100),
					duration: t(100),
					trimStart: t(0),
					trimEnd: t(0),
					params: { text: "hello" },
				},
				{
					id: "word-2",
					type: "text",
					name: "world",
					startTime: t(300),
					duration: t(100),
					trimStart: t(0),
					trimEnd: t(0),
					params: { text: "world" },
				},
			],
		},
	],
	main: {
		id: "main",
		name: "Main",
		type: "video",
		hidden: false,
		muted: false,
		elements: [
			{
				id: "video-1",
				type: "video",
				name: "clip",
				mediaId: "media-1",
				startTime: t(0),
				duration: t(500),
				trimStart: t(0),
				trimEnd: t(0),
				params: {},
			},
		],
	},
	audio: [],
};

describe("timeline context index", () => {
	test("detects half-open range overlaps", () => {
		expect(
			rangesOverlap({
				firstStart: 0,
				firstEnd: 100,
				secondStart: 100,
				secondEnd: 200,
			}),
		).toBe(false);
		expect(
			rangesOverlap({
				firstStart: 0,
				firstEnd: 101,
				secondStart: 100,
				secondEnd: 200,
			}),
		).toBe(true);
	});

	test("finds elements and layers in a selected range", () => {
		const index = buildTimelineContextIndex({ tracks });
		const range = { startTime: t(250), endTime: t(360) };

		expect(
			getElementsInRange({ index, range }).map((element) => element.elementId),
		).toEqual(["video-1", "word-2"]);
		expect(getLayersInRange({ index, range }).map((layer) => layer.id)).toEqual(
			["text-track", "main"],
		);
	});

	test("pages layer and element search results", () => {
		const index = buildTimelineContextIndex({ tracks });

		expect(searchLayers({ index, query: "main" }).items[0]?.id).toBe("main");
		const firstPage = searchElements({ index, cursor: 0, limit: 1 });
		expect(firstPage.items).toHaveLength(1);
		expect(firstPage.nextCursor).toBe(1);
		expect(searchElements({ index, query: "world" }).items[0]?.elementId).toBe(
			"word-2",
		);
	});

	test("builds a prioritized timeline document", () => {
		const document = buildTimelineDocument({
			tracks,
			range: { startTime: t(250), endTime: t(360) },
			selectedElements: [{ trackId: "text-track", elementId: "word-1" }],
			maxElements: 2,
		});
		const parsed = JSON.parse(document) as {
			elements: Array<{
				elementId: string;
				selected?: boolean;
				inActiveRange?: boolean;
			}>;
			totals: { truncated: boolean };
		};

		expect(parsed.totals.truncated).toBe(true);
		expect(parsed.elements.map((element) => element.elementId)).toEqual([
			"video-1",
			"word-1",
		]);
		expect(parsed.elements[1]?.selected).toBe(true);
		expect(parsed.elements[0]?.inActiveRange).toBe(true);
	});

	test("includes timeline source in the prompt", () => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only implements the editor APIs this prompt builder reads.
		const editor = {
			scenes: {
				getActiveSceneOrNull: () => ({
					bookmarks: [],
					tracks,
				}),
			},
			project: {
				getActiveOrNull: () => ({
					metadata: { name: "Prompt Smoke" },
				}),
			},
			media: {
				getAssets: () => [],
			},
			playback: {
				getCurrentTime: () => t(0),
			},
		} as unknown as EditorCore;

		const prompt = buildTimelineContextPrompt({
			editor,
			range: { startTime: t(250), endTime: t(360) },
			includeActiveRange: true,
		});

		expect(prompt).toContain("Timeline summary:");
		expect(prompt).toContain("Active range summary: 2 layers and 2 elements");
		expect(prompt).toContain("OPENCUT_TIMELINE_SOURCE");
		expect(prompt).toContain('el {"id":"word-2"');
	});
});
