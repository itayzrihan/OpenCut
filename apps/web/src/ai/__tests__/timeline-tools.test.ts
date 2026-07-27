import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { ExportState } from "@/export";
import type { AiEditPlan } from "@/ai/types";
import {
	ALLOWED_AI_TOOL_WIRE_NAMES,
	isAllowedAiToolWireName,
} from "@/ai/tool-wire-names";
import { mediaTime } from "@/wasm";

function sortJsonForCanonicalizer(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonForCanonicalizer);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, sortJsonForCanonicalizer(child)]),
	);
}

function stableTestHash(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalizeTimelineSourceDocumentForTest({ json }: { json: string }) {
	try {
		const canonical = sortJsonForCanonicalizer(JSON.parse(json));
		const compact = JSON.stringify(canonical);
		return {
			valid: true,
			formattedJson: `${JSON.stringify(canonical, null, 2)}\n`,
			baseRevision: `mock-sha256:${stableTestHash(compact)}`,
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

interface TestScopeElement {
	id: string;
	startTime: number;
	duration: number;
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
	const before = JSON.parse(beforeJson) as {
		scene: { tracks: Array<{ elements: TestScopeElement[] }> };
	};
	const after = JSON.parse(afterJson) as typeof before;
	if (!selectedRange) return { valid: true, diagnostics: [] };
	const rangeEnd = selectedRange.startTime + selectedRange.duration;
	const collect = (document: typeof before) =>
		new Map(
			document.scene.tracks.flatMap((track) =>
				track.elements.map((element) => [element.id, element] as const),
			),
		);
	const beforeElements = collect(before);
	const afterElements = collect(after);
	const diagnostics: Array<{ code: string; path: string; message: string }> =
		[];
	for (const id of new Set([
		...beforeElements.keys(),
		...afterElements.keys(),
	])) {
		const oldElement = beforeElements.get(id);
		const newElement = afterElements.get(id);
		if (JSON.stringify(oldElement) === JSON.stringify(newElement)) continue;
		for (const element of [oldElement, newElement]) {
			if (
				element &&
				(element.startTime < selectedRange.startTime ||
					element.startTime + element.duration > rangeEnd)
			) {
				diagnostics.push({
					code: "range_element_out_of_scope",
					path: "$.scene.tracks",
					message: `Element "${id}" was changed outside the selected range`,
				});
				break;
			}
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
	}) => {
		const duration = endTime - startTime;
		if (duration < 2) {
			return { valid: false, times: [], reason: "Range is too short" };
		}
		const durationSeconds = duration / 120_000;
		const count = Math.min(
			durationSeconds <= 4 ? 2 : durationSeconds <= 12 ? 3 : 4,
			Math.max(2, Math.min(4, Math.floor(maxFrames))),
		);
		return {
			valid: true,
			times: Array.from({ length: count }, (_, index) =>
				Math.round(startTime + (duration * (index + 0.5)) / count),
			),
		};
	},
	canonicalizeTimelineSourceDocument: canonicalizeTimelineSourceDocumentForTest,
	validateTimelineSourceV2MutationScope:
		validateTimelineSourceV2MutationScopeForTest,
}));

mock.module("@/shared-library", () => ({
	sharedLibraryService: {
		listAudioAssets: async () => [
			{
				id: "audio-1",
				name: "Whoosh impact",
				folder: "sfx",
				duration: 1.25,
				mimeType: "audio/mpeg",
			},
			{
				id: "audio-2",
				name: "Cinematic boom",
				folder: "sfx",
				duration: 0.75,
				mimeType: "audio/mpeg",
			},
			{
				id: "music-1",
				name: "Cinematic theme",
				folder: "music",
				duration: 20,
				mimeType: "audio/mpeg",
			},
		],
		listStickerAssets: async () => [
			{
				id: "sticker-1",
				name: "Spark burst",
				width: 512,
				height: 384,
				mimeType: "image/png",
			},
		],
		listCaptionPresets: async () => [],
		listGeneratedBackgrounds: async () => [],
		listGeneratedEffects: async () => [],
	},
}));

let createTimelineToolRuntime: typeof import("@/ai/timeline-tools").createTimelineToolRuntime;
let buildAiSystemPrompt: typeof import("@/ai/timeline-tools").buildAiSystemPrompt;
let buildTimelineContextPrompt: typeof import("@/ai/timeline-tools").buildTimelineContextPrompt;
let createTimelineToolDefinitions: typeof import("@/ai/timeline-tools").createTimelineToolDefinitions;
let getRequestedSfxMinimum: typeof import("@/ai/timeline-tools").getRequestedSfxMinimum;
let hasExplicitVfxRequest: typeof import("@/ai/timeline-tools").hasExplicitVfxRequest;

beforeAll(async () => {
	({
		buildAiSystemPrompt,
		buildTimelineContextPrompt,
		createTimelineToolDefinitions,
		createTimelineToolRuntime,
		getRequestedSfxMinimum,
		hasExplicitVfxRequest,
	} = await import("@/ai/timeline-tools"));
});

describe("AI tool wire-name boundary", () => {
	test("allows every editor definition plus capability search and rejects unknown names", () => {
		const definitionWireNames = createTimelineToolDefinitions().map((tool) =>
			tool.name.replaceAll(".", "_"),
		);
		const expectedWireNames = new Set([
			...definitionWireNames,
			"capabilities_search",
		]);

		expect(
			definitionWireNames.every((name) => isAllowedAiToolWireName({ name })),
		).toBe(true);
		expect(isAllowedAiToolWireName({ name: "capabilities_search" })).toBe(true);
		expect([...ALLOWED_AI_TOOL_WIRE_NAMES].sort()).toEqual(
			[...expectedWireNames].sort(),
		);
		expect(isAllowedAiToolWireName({ name: "timeline_unknown_tool" })).toBe(
			false,
		);
	});
});

describe("AI creative direction capabilities", () => {
	test("auto-loads creative direction for a broad epic request", () => {
		const prompt = buildAiSystemPrompt({ userRequest: "make this epic" });

		expect(prompt).toContain("AUTO-LOADED CREATIVE DIRECTION SKILL:");
		expect(prompt).toContain("# Creative direction preflight");
		expect(prompt).toContain("Do not add categories just to fill a quota");
		expect(prompt).toContain("Use catalog.search with the request's intent");
	});

	test("auto-loads creative direction and detects explicit SFX/VFX coverage", () => {
		for (const request of [
			"make this amazing",
			"add VFX",
			"add visual effects",
			"add some SFX",
			"improve the sound design",
		]) {
			expect(buildAiSystemPrompt({ userRequest: request })).toContain(
				"AUTO-LOADED CREATIVE DIRECTION SKILL:",
			);
		}
		expect(getRequestedSfxMinimum({ request: "add some SFX" })).toBe(2);
		expect(getRequestedSfxMinimum({ request: "add one whoosh" })).toBe(1);
		expect(getRequestedSfxMinimum({ request: "no SFX, only VFX" })).toBe(0);
		expect(hasExplicitVfxRequest({ request: "add VFX" })).toBe(true);
		expect(hasExplicitVfxRequest({ request: "make it amazing" })).toBe(false);
		expect(hasExplicitVfxRequest({ request: "without visual effects" })).toBe(
			false,
		);
	});

	test("keeps the default prompt broad without embedding transition ids or premium bias", () => {
		const prompt = buildAiSystemPrompt();

		expect(prompt).not.toContain("AUTO-LOADED CREATIVE DIRECTION SKILL:");
		expect(prompt).not.toContain("Transition presets:");
		expect(prompt).not.toContain("premium cinematic presets");
		expect(prompt).not.toContain("cinematic-glide");
		expect(prompt).not.toContain("whip-pan");
		expect(prompt).not.toContain("dolly-zoom");
		expect(prompt).toContain("UI elements");
		expect(prompt).toContain("backgrounds");
		expect(prompt).toContain("overlay movement");
		expect(prompt).toContain("perspective");
		expect(prompt).toContain("timeline.stage_operations");
		expect(prompt).toContain("insert_library_audio_element");
		expect(prompt).toContain('"libraryAssetId":"<result id>"');
		expect(prompt).toContain("<returned durationTicks");
	});

	test("defines searchable creative domains and an always-loaded staging tool", () => {
		const definitions = createTimelineToolDefinitions();
		const catalogSearch = definitions.find(
			(tool) => tool.name === "catalog.search",
		);
		const stageOperations = definitions.find(
			(tool) => tool.name === "timeline.stage_operations",
		);
		const librarySearch = definitions.find(
			(tool) => tool.name === "library.search",
		);

		expect(catalogSearch).toMatchObject({
			deferLoading: true,
			category: "creative app knowledge",
			parameters: {
				properties: {
					domains: {
						items: {
							enum: [
								"effects",
								"masks",
								"graphics",
								"transitions",
								"ui_elements",
								"backgrounds",
								"overlay_effects",
								"overlay_movement",
								"actions",
							],
						},
					},
				},
			},
		});
		expect(stageOperations).toMatchObject({
			category: "timeline edit",
		});
		expect(stageOperations?.deferLoading).toBeUndefined();
		expect(stageOperations?.description).toContain(
			"merged with all timeline.edit_source changes",
		);
		expect(stageOperations?.description).toContain(
			"insert_library_audio_element",
		);
		expect(librarySearch?.description).toContain("integer durationTicks");
	});

	test("keeps full-fidelity source tools deferred and server-allowlisted", () => {
		const definitions = createTimelineToolDefinitions();
		const readFullSource = definitions.find(
			(tool) => tool.name === "timeline.read_full_source",
		);
		const editFullSource = definitions.find(
			(tool) => tool.name === "timeline.edit_full_source",
		);

		expect(readFullSource).toMatchObject({
			deferLoading: true,
			category: "timeline full source read",
		});
		expect(editFullSource).toMatchObject({
			deferLoading: true,
			category: "timeline full source edit",
		});
		expect(isAllowedAiToolWireName({ name: "timeline_read_full_source" })).toBe(
			true,
		);
		expect(isAllowedAiToolWireName({ name: "timeline_edit_full_source" })).toBe(
			true,
		);
	});

	test("pages oversized compact source instead of spending initial context on it", () => {
		const prompt = buildTimelineContextPrompt({
			editor: createFullSourceEditorFixture({
				insideContent: "x".repeat(17_000),
			}).editor,
		});

		expect(prompt).toContain("was not embedded");
		expect(prompt).toContain("timeline.read_source (start cursor 0)");
		expect(prompt).toContain("use nextCursor");
		expect(prompt).not.toContain("x".repeat(128));
	});
});

describe("AI timeline tool access", () => {
	test("keeps app knowledge while gating timeline, media, preview, and controls", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: {} as EditorCore,
			options: {
				includeLayerAccess: false,
				includeMediaAccess: false,
				includePreviewImage: false,
				includeAppControlAccess: false,
			},
			authorizeCapabilities: authorizeForTest,
		});
		const names = runtime.tools.map((tool) => tool.name);

		expect(names).toContain("app.get_state");
		expect(names).toContain("catalog.search");
		expect(names).toContain("catalog.list");
		expect(names).toContain("catalog.get");
		expect(names).toContain("skills.list");
		expect(names).toContain("skills.load");
		expect(names).toContain("timeline.propose_edit_plan");
		expect(names).toContain("export.get_status");
		expect(names).toContain("transcription.get_status");
		expect(names).not.toContain("timeline.read_source");
		expect(names).not.toContain("timeline.edit_source");
		expect(names).not.toContain("timeline.stage_operations");
		expect(names).not.toContain("timeline.list_media");
		expect(names).not.toContain("library.search");
		expect(names).not.toContain("preview.capture_frame");
		expect(names).not.toContain("preview.capture_range_frames");
		expect(names).not.toContain("playback.control");
		expect(names).not.toContain("scene.activate");
		expect(names).not.toContain("captions.get_source");
		expect(names).not.toContain("export.cancel");
		expect(names).not.toContain("transcription.cancel");
		expect(runtime.networkResearchAllowed).toBe(false);
		await expect(
			runtime.executeTool({
				id: "blocked-control",
				name: "playback.control",
				arguments: { operation: "play" },
			}),
		).rejects.toThrow("not authorized");
	});

	test("captures a bounded representative range storyboard without seeking playback", async () => {
		const capturedTimes: number[] = [];
		const scene = {
			id: "scene-1",
			name: "Main scene",
			isMain: true,
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		const editor = {
			scenes: { getActiveSceneOrNull: () => scene },
			media: { getAssets: () => [] },
			project: {
				getActiveOrNull: () => ({
					settings: { canvasSize: { width: 1920, height: 1080 } },
				}),
			},
			playback: { getCurrentTime: () => 777_000 },
			renderer: {
				capturePreviewFrameAt: async ({
					time,
					maxDimension,
					maxBytes,
				}: {
					time: number;
					maxDimension: number;
					maxBytes: number;
				}) => {
					expect(maxDimension).toBe(512);
					expect(maxBytes).toBe(90_000);
					capturedTimes.push(time);
					return {
						success: true as const,
						filename: `frame-${time}.jpg`,
						blob: new Blob([`frame-${time}`], { type: "image/jpeg" }),
					};
				},
			},
		} as unknown as EditorCore;
		const range = {
			startTime: mediaTime({ ticks: 0 }),
			endTime: mediaTime({ ticks: 2_400_000 }),
		};
		const runtime = await createTimelineToolRuntime({
			editor,
			options: { range, includePreviewImage: true },
			authorizeCapabilities: authorizeForTest,
		});

		expect(runtime.tools.map((tool) => tool.name)).toContain(
			"preview.capture_range_frames",
		);
		const inspection = (await runtime.executeTool({
			id: "inspect-range",
			name: "timeline.inspect_range",
			arguments: {},
		})) as { visualPreview: { available: boolean; capability: string } };
		expect(inspection.visualPreview).toEqual(
			expect.objectContaining({
				available: true,
				capability: "preview.capture_range_frames",
			}),
		);

		const result = (await runtime.executeTool({
			id: "range-preview",
			name: "preview.capture_range_frames",
			arguments: { maxFrames: 4 },
		})) as {
			frameCount: number;
			totalDataUrlCharacters: number;
			frames: Array<{ time: number; dataUrl: string; byteSize: number }>;
		};

		expect(capturedTimes).toEqual([300_000, 900_000, 1_500_000, 2_100_000]);
		expect(result.frameCount).toBe(4);
		expect(result.frames).toHaveLength(4);
		expect(
			result.frames.every((frame) =>
				frame.dataUrl.startsWith("data:image/jpeg;base64,"),
			),
		).toBe(true);
		expect(result.frames.every((frame) => frame.byteSize <= 90_000)).toBe(true);
		expect(result.totalDataUrlCharacters).toBeLessThanOrEqual(500_000);
		expect(editor.playback.getCurrentTime()).toBe(777_000);
	});

	test("searches only the requested creative catalog domains", async () => {
		const scene = {
			id: "scene-1",
			name: "Main scene",
			isMain: true,
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: { getActiveSceneOrNull: () => scene },
				media: { getAssets: () => [] },
			} as unknown as EditorCore,
			authorizeCapabilities: authorizeForTest,
		});

		const result = await runtime.executeTool({
			id: "creative-search",
			name: "catalog.search",
			arguments: {
				query: "epic",
				domains: ["backgrounds", "overlay_effects"],
				limit: 6,
			},
		});

		expect(result).toMatchObject({
			query: "epic",
			expandedQuery: expect.stringContaining("cinematic impact"),
		});
		const items = (result as { items: Array<{ domain: string }> }).items;
		expect(items.length).toBeGreaterThan(0);
		expect(
			items.every((item) =>
				["backgrounds", "overlay_effects"].includes(item.domain),
			),
		).toBe(true);
	});

	test("merges source edits and typed operations into one staged plan", async () => {
		const scene = {
			id: "scene-1",
			name: "Main scene",
			isMain: true,
			bookmarks: [],
			createdAt: new Date(0),
			updatedAt: new Date(0),
			tracks: {
				overlay: [
					{
						id: "text-track",
						name: "Titles",
						type: "text",
						hidden: false,
						elements: [
							{
								id: "title-1",
								name: "Title",
								type: "text",
								startTime: 0,
								duration: 120_000,
								trimStart: 0,
								trimEnd: 0,
								params: { content: "Hello" },
							},
						],
					},
				],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["text-track", "main"],
			},
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: {
					getActiveSceneOrNull: () => scene,
					getScenes: () => [scene],
				},
				media: { getAssets: () => [] },
				project: {
					getActive: () => ({
						metadata: { id: "project-1", name: "Project" },
						settings: {
							fps: { numerator: 30, denominator: 1 },
							canvasSize: { width: 1920, height: 1080 },
							background: { type: "color", color: "#000000" },
						},
					}),
					getExportState: () => ({
						isExporting: false,
						progress: 0,
						result: null,
						options: null,
					}),
				},
				transcription: {
					getState: () => ({
						task: {
							taskId: null,
							kind: "transcription",
							status: "idle",
							progressBasisPoints: 0,
							phase: "idle",
						},
						language: "auto",
						sceneId: null,
						insertedTrackIds: [],
					}),
				},
			} as unknown as EditorCore,
			authorizeCapabilities: authorizeForTest,
		});

		const sourcePage = (await runtime.executeTool({
			id: "read-source",
			name: "timeline.read_source",
			arguments: {},
		})) as { items: Array<{ text: string }> };
		const titleLine = sourcePage.items.find((item) =>
			item.text.includes('"text":"Hello"'),
		)?.text;
		expect(titleLine).toBeDefined();
		await runtime.executeTool({
			id: "edit-source",
			name: "timeline.edit_source",
			arguments: {
				edits: [
					{
						oldText: titleLine,
						newText: titleLine?.replace('"text":"Hello"', '"text":"EPIC"'),
					},
				],
			},
		});
		const staged = await runtime.executeTool({
			id: "stage-typed",
			name: "timeline.stage_operations",
			arguments: {
				plan: {
					title: "Epic treatment",
					summary: "Restyle the title and canvas",
					operations: [
						{
							type: "set_project_settings",
							background: { type: "color", color: "#101820" },
						},
					],
					notes: ["Typed finishing pass"],
				},
			},
		});

		expect(staged).toMatchObject({
			success: true,
			pendingOperations: 2,
			operationTypes: ["update_element", "set_project_settings"],
		});
		expect(runtime.getSourceEditPlan()).toMatchObject({
			title: "Epic treatment",
			summary: "Restyle the title and canvas",
			operations: [
				{
					type: "update_element",
					trackId: "text-track",
					elementId: "title-1",
					patch: { params: { content: "EPIC" } },
				},
				{
					type: "set_project_settings",
					background: { type: "color", color: "#101820" },
				},
			],
			notes: ["Typed finishing pass"],
		});
	});

	test("pages canonical Timeline Source v2 without loading it all at once", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			authorizeCapabilities: authorizeForTest,
		});

		const firstPage = (await runtime.executeTool({
			id: "read-full-source-first",
			name: "timeline.read_full_source",
			arguments: { cursor: 0, limit: 3 },
		})) as {
			schemaVersion: number;
			baseRevision: string;
			staged: boolean;
			items: Array<{ lineNumber: number; text: string }>;
			cursor: number;
			nextCursor: number | null;
			totalLines: number;
		};
		expect(firstPage).toMatchObject({
			schemaVersion: 2,
			staged: false,
			cursor: 0,
			nextCursor: 3,
		});
		expect(firstPage.baseRevision).toStartWith("mock-sha256:");
		expect(firstPage.items).toHaveLength(3);
		expect(firstPage.totalLines).toBeGreaterThan(firstPage.items.length);

		const secondPage = (await runtime.executeTool({
			id: "read-full-source-second",
			name: "timeline.read_full_source",
			arguments: { cursor: firstPage.nextCursor, limit: 2 },
		})) as {
			baseRevision: string;
			items: Array<{ lineNumber: number }>;
			cursor: number;
		};
		expect(secondPage.baseRevision).toBe(firstPage.baseRevision);
		expect(secondPage.cursor).toBe(3);
		expect(secondPage.items[0]?.lineNumber).toBe(4);
	});

	test("stages one exact full-source mutation as a reviewed v2 operation", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			options: { range: { startTime: 120_000, endTime: 360_000 } },
			authorizeCapabilities: authorizeForTest,
		});
		const source = await readEntireFullSource(runtime);
		const contentLine = source.items.find((item) =>
			item.text.includes('"content": "Inside copy"'),
		)?.text;
		expect(contentLine).toBeDefined();

		const result = await runtime.executeTool({
			id: "edit-full-source",
			name: "timeline.edit_full_source",
			arguments: {
				edits: [
					{
						oldText: contentLine,
						newText: contentLine?.replace("Inside copy", "EPIC copy"),
					},
				],
			},
		});

		expect(result).toMatchObject({
			success: true,
			appliedEdits: 1,
			pendingOperations: 1,
			baseRevision: source.baseRevision,
		});
		expect(runtime.getSourceEditPlan()).toMatchObject({
			operations: [
				{
					type: "apply_timeline_source_v2",
					baseRevision: source.baseRevision,
					scope: { startTime: 120_000, endTime: 360_000 },
				},
			],
		});
		const operation = runtime.getSourceEditPlan()?.operations[0];
		expect(operation?.type).toBe("apply_timeline_source_v2");
		if (operation?.type !== "apply_timeline_source_v2") {
			throw new Error("Expected a full Timeline Source operation");
		}
		expect(operation.document).toContain('"content": "EPIC copy"');
	});

	test("rejects a full-source mutation that escapes the selected range", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			options: { range: { startTime: 120_000, endTime: 360_000 } },
			authorizeCapabilities: authorizeForTest,
		});
		const source = await readEntireFullSource(runtime);
		const outsideLine = source.items.find((item) =>
			item.text.includes('"content": "Outside copy"'),
		)?.text;
		expect(outsideLine).toBeDefined();

		await expect(
			runtime.executeTool({
				id: "escape-range",
				name: "timeline.edit_full_source",
				arguments: {
					edits: [
						{
							oldText: outsideLine,
							newText: outsideLine?.replace("Outside copy", "Escaped"),
						},
					],
				},
			}),
		).rejects.toThrow("outside the selected range");
		expect(runtime.getSourceEditPlan()).toBeNull();
	});

	test("isolates full-source edits from typed and compact edit strategies", async () => {
		const fullFirst = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			authorizeCapabilities: authorizeForTest,
		});
		const source = await readEntireFullSource(fullFirst);
		const contentLine = source.items.find((item) =>
			item.text.includes('"content": "Inside copy"'),
		)?.text;
		await fullFirst.executeTool({
			id: "full-first",
			name: "timeline.edit_full_source",
			arguments: {
				edits: [
					{
						oldText: contentLine,
						newText: contentLine?.replace("Inside copy", "Full first"),
					},
				],
			},
		});
		await expect(
			fullFirst.executeTool({
				id: "typed-after-full",
				name: "timeline.stage_operations",
				arguments: { plan: { operations: [] } },
			}),
		).rejects.toThrow("cannot be mixed");
		await expect(
			fullFirst.executeTool({
				id: "compact-after-full",
				name: "timeline.edit_source",
				arguments: { edits: [] },
			}),
		).rejects.toThrow("cannot be mixed");

		const typedFirst = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			authorizeCapabilities: authorizeForTest,
		});
		await typedFirst.executeTool({
			id: "typed-first",
			name: "timeline.stage_operations",
			arguments: {
				plan: {
					title: "Typed first",
					summary: "",
					operations: [
						{
							type: "set_project_settings",
							background: { type: "color", color: "#101820" },
						},
					],
				},
			},
		});
		const typedSource = await readEntireFullSource(typedFirst);
		const typedContentLine = typedSource.items.find((item) =>
			item.text.includes('"content": "Inside copy"'),
		)?.text;
		await expect(
			typedFirst.executeTool({
				id: "full-after-typed",
				name: "timeline.edit_full_source",
				arguments: {
					edits: [
						{
							oldText: typedContentLine,
							newText: typedContentLine?.replace("Inside copy", "Typed first"),
						},
					],
				},
			}),
		).rejects.toThrow("cannot be mixed");
	});

	test("authorizes isolated web research only with the explicit network grant", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: {} as EditorCore,
			options: { includeNetworkAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		expect(runtime.networkResearchAllowed).toBe(true);
		expect(runtime.tools.map((tool) => tool.name)).not.toContain(
			"web.research",
		);
	});

	test("exposes playback control only with its explicit grant", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: {} as EditorCore,
			options: { includeAppControlAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		expect(runtime.tools.map((tool) => tool.name)).toContain(
			"playback.control",
		);
		expect(runtime.tools.map((tool) => tool.name)).toContain("scene.activate");
		expect(runtime.tools.map((tool) => tool.name)).toContain("export.cancel");
		expect(runtime.tools.map((tool) => tool.name)).toContain(
			"transcription.cancel",
		);
	});

	test("executes explicit playback desired states", async () => {
		let currentTime = 0;
		let isPlaying = false;
		let volume = 1;
		let muted = false;
		const scene = {
			id: "scene-1",
			name: "Main scene",
			isMain: true,
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		const editor = {
			scenes: { getActiveSceneOrNull: () => scene },
			media: { getAssets: () => [] },
			playback: {
				play: () => {
					isPlaying = true;
				},
				pause: () => {
					isPlaying = false;
				},
				seek: ({ time }: { time: number }) => {
					currentTime = time;
				},
				setVolume: ({ volume: next }: { volume: number }) => {
					volume = next;
				},
				mute: () => {
					muted = true;
				},
				unmute: () => {
					muted = false;
				},
				getCurrentTime: () => currentTime,
				getIsPlaying: () => isPlaying,
				getVolume: () => volume,
				isMuted: () => muted,
			},
		} as unknown as EditorCore;
		const runtime = await createTimelineToolRuntime({
			editor,
			options: { includeAppControlAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		await runtime.executeTool({
			id: "seek",
			name: "playback.control",
			arguments: { operation: "seek", timeSeconds: 2.5 },
		});
		await runtime.executeTool({
			id: "mute",
			name: "playback.control",
			arguments: { operation: "set_muted", muted: true },
		});

		expect(currentTime).toBe(300_000);
		expect(muted).toBe(true);
	});

	test("activates an existing scene by desired id", async () => {
		const scenes = [
			{
				id: "scene-1",
				name: "Main",
				isMain: true,
				bookmarks: [],
				tracks: {
					overlay: [],
					main: {
						id: "main-1",
						name: "Main",
						type: "video",
						elements: [],
						muted: false,
						hidden: false,
					},
					audio: [],
					order: ["main-1"],
				},
			},
			{
				id: "scene-2",
				name: "Alternate",
				isMain: false,
				bookmarks: [],
				tracks: {
					overlay: [],
					main: {
						id: "main-2",
						name: "Main",
						type: "video",
						elements: [],
						muted: false,
						hidden: false,
					},
					audio: [],
					order: ["main-2"],
				},
			},
		];
		let activeScene = scenes[0];
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: {
					getActiveSceneOrNull: () => activeScene,
					getScenes: () => scenes,
					switchToScene: async ({ sceneId }: { sceneId: string }) => {
						activeScene = scenes.find((scene) => scene.id === sceneId);
					},
				},
				media: { getAssets: () => [] },
			} as unknown as EditorCore,
			options: { includeAppControlAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		const result = await runtime.executeTool({
			id: "scene",
			name: "scene.activate",
			arguments: { sceneId: "scene-2" },
		});

		expect(activeScene?.id).toBe("scene-2");
		expect(result).toEqual({
			id: "scene-2",
			name: "Alternate",
			isMain: false,
		});
	});

	test("pages canonical caption words with owning element references", async () => {
		const scene = {
			id: "scene-1",
			name: "Main scene",
			bookmarks: [],
			tracks: {
				overlay: [
					{
						id: "captions",
						name: "Captions",
						type: "text",
						hidden: false,
						elements: [],
						captionSource: {
							sourceId: "source-1",
							words: [
								{
									text: "Hello",
									start: 0,
									end: 0.5,
									source: {
										type: "text-layer",
										trackId: "captions",
										elementId: "caption-1",
										wordIndex: 0,
									},
								},
								{ text: "world", start: 0.5, end: 1 },
							],
							settings: {},
							layerCount: 1,
						},
					},
				],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["captions", "main"],
			},
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: { getActiveSceneOrNull: () => scene },
				media: { getAssets: () => [] },
			} as unknown as EditorCore,
			authorizeCapabilities: authorizeForTest,
		});

		const result = await runtime.executeTool({
			id: "captions",
			name: "captions.get_source",
			arguments: {
				sourceIdOrTrackId: "source-1",
				cursor: 0,
				limit: 1,
			},
		});

		expect(result).toMatchObject({
			words: [
				{
					text: "Hello",
					source: { trackId: "captions", elementId: "caption-1" },
				},
			],
			nextCursor: 1,
		});
	});

	test("reports and cancels exports without exposing the result buffer", async () => {
		let cancelled = false;
		const scene = {
			id: "scene-1",
			name: "Main",
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		let exportState: ExportState = {
			isExporting: false,
			progress: 1,
			result: { success: true, buffer: new ArrayBuffer(8) },
			options: { format: "mp4", quality: "high" },
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: { getActiveSceneOrNull: () => scene },
				media: { getAssets: () => [] },
				project: {
					getExportState: () => exportState,
					cancelExport: () => {
						cancelled = true;
					},
				},
			} as unknown as EditorCore,
			options: { includeAppControlAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		const status = await runtime.executeTool({
			id: "status",
			name: "export.get_status",
			arguments: {},
		});
		exportState = {
			isExporting: true,
			progress: 0.4,
			result: null,
			options: { format: "mp4", quality: "high" },
		};
		await runtime.executeTool({
			id: "cancel",
			name: "export.cancel",
			arguments: {},
		});

		expect(status).toEqual({
			status: "ready",
			progress: 1,
			options: { format: "mp4", quality: "high" },
			downloadReady: true,
			error: undefined,
			message:
				"Export is ready. The user can download it from the Export menu.",
		});
		expect(JSON.stringify(status)).not.toContain("buffer");
		expect(cancelled).toBe(true);
	});

	test("reports and cancels transcription without exposing audio or transcript text", async () => {
		let taskState = {
			task: {
				taskId: "task-1",
				kind: "transcription",
				status: "running",
				progressBasisPoints: 4_200,
				phase: "transcribing",
				error: undefined,
			},
			language: "en" as const,
			sceneId: "scene-1",
			insertedTrackIds: [] as string[],
		};
		const scene = {
			id: "scene-1",
			name: "Main",
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: { getActiveSceneOrNull: () => scene },
				media: { getAssets: () => [] },
				transcription: {
					getState: () => taskState,
					cancel: () => {
						taskState = {
							...taskState,
							task: {
								...taskState.task,
								status: "cancelling",
								phase: "cancelling",
							},
						};
						return taskState;
					},
				},
			} as unknown as EditorCore,
			options: { includeAppControlAccess: true },
			authorizeCapabilities: authorizeForTest,
		});

		const status = await runtime.executeTool({
			id: "transcription-status",
			name: "transcription.get_status",
			arguments: {},
		});
		const cancelled = await runtime.executeTool({
			id: "transcription-cancel",
			name: "transcription.cancel",
			arguments: {},
		});

		expect(status).toEqual({
			status: "running",
			progress: 0.42,
			phase: "transcribing",
			language: "en",
			sceneId: "scene-1",
			insertedTrackIds: [],
			error: undefined,
		});
		expect(cancelled).toMatchObject({
			status: "cancelling",
			phase: "cancelling",
		});
		expect(JSON.stringify(status)).not.toMatch(/audio|hello|transcriptText/);
	});

	test("searches bounded shared-library metadata", async () => {
		const scene = {
			id: "scene-1",
			name: "Main",
			bookmarks: [],
			tracks: {
				overlay: [],
				main: {
					id: "main",
					name: "Main",
					type: "video",
					elements: [],
					muted: false,
					hidden: false,
				},
				audio: [],
				order: ["main"],
			},
		};
		const runtime = await createTimelineToolRuntime({
			editor: {
				scenes: { getActiveSceneOrNull: () => scene },
				media: { getAssets: () => [] },
			} as unknown as EditorCore,
			authorizeCapabilities: authorizeForTest,
		});

		const result = await runtime.executeTool({
			id: "library",
			name: "library.search",
			arguments: { domain: "audio", query: "whoosh", limit: 5 },
		});
		const stickers = await runtime.executeTool({
			id: "library-stickers",
			name: "library.search",
			arguments: { domain: "stickers", query: "spark", limit: 5 },
		});

		expect(result).toEqual({
			domain: "audio",
			items: [
				{
					id: "audio-1",
					name: "Whoosh impact",
					folder: "sfx",
					durationSeconds: 1.25,
					durationTicks: 150_000,
					insertionReady: true,
					mimeType: "audio/mpeg",
				},
			],
			total: 1,
			nextCursor: null,
		});
		expect(stickers).toEqual({
			domain: "stickers",
			items: [
				{
					id: "user-stickers:sticker-1",
					stickerId: "user-stickers:sticker-1",
					sharedAssetId: "sticker-1",
					name: "Spark burst",
					width: 512,
					height: 384,
					mimeType: "image/png",
				},
			],
			total: 1,
			nextCursor: null,
		});
	});

	test("stages a searched shared-audio result as a reviewed typed operation", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			authorizeCapabilities: authorizeForTest,
		});

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the mocked library tool has this stable result contract.
		const searched = (await runtime.executeTool({
			id: "library-audio",
			name: "library.search",
			arguments: { domain: "audio", query: "whoosh", limit: 5 },
		})) as {
			items: Array<{ id: string; name: string; durationSeconds: number }>;
		};
		const audio = searched.items[0];
		if (!audio) throw new Error("Expected shared audio fixture");

		const staged = await runtime.executeTool({
			id: "stage-library-audio",
			name: "timeline.stage_operations",
			arguments: {
				plan: {
					title: "Add whoosh",
					summary: "Add the selected shared sound effect",
					operations: [
						{
							type: "insert_library_audio_element",
							libraryAssetId: audio.id,
							name: audio.name,
							startTime: 120_000,
							duration: audio.durationSeconds * 120_000,
						},
					],
				},
			},
		});

		expect(staged).toMatchObject({
			success: true,
			pendingOperations: 1,
			operationTypes: ["insert_library_audio_element"],
		});
		expect(runtime.getSourceEditPlan()).toMatchObject({
			operations: [
				{
					type: "insert_library_audio_element",
					libraryAssetId: "audio-1",
					name: "Whoosh impact",
					startTime: 120_000,
					duration: 150_000,
				},
			],
		});
	});

	test("preloads and enforces searched SFX plus explicit VFX coverage", async () => {
		const runtime = await createTimelineToolRuntime({
			editor: createFullSourceEditorFixture().editor,
			options: { userRequest: "Add some epic SFX and VFX" },
			authorizeCapabilities: authorizeForTest,
		});

		expect(
			runtime.tools.find((tool) => tool.name === "library.search")
				?.deferLoading,
		).toBe(false);
		expect(
			runtime.tools.find((tool) => tool.name === "catalog.search")
				?.deferLoading,
		).toBe(false);
		expect(runtime.getCompletionErrors(null).join("\n")).toContain(
			"explicitly requires SFX",
		);
		expect(runtime.getCompletionErrors(null).join("\n")).toContain(
			"explicitly requires VFX",
		);

		await expect(
			runtime.executeTool({
				id: "invented-audio",
				name: "timeline.stage_operations",
				arguments: {
					plan: {
						title: "Invented",
						summary: "",
						operations: [
							{
								type: "insert_library_audio_element",
								libraryAssetId: "made-up-id",
								name: "Made up",
								startTime: 0,
								duration: 120_000,
							},
						],
					},
				},
			}),
		).rejects.toThrow("was not returned by library.search");

		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the mocked library result has this focused insertion contract.
		const search = (await runtime.executeTool({
			id: "search-epic-sfx",
			name: "library.search",
			arguments: { domain: "audio", query: "epic sound effects", limit: 8 },
		})) as {
			items: Array<{
				id: string;
				name: string;
				folder: string;
				durationTicks: number;
			}>;
		};
		expect(search.items).toHaveLength(2);
		expect(search.items.every((item) => item.folder === "sfx")).toBe(true);

		const audioOperations: AiEditPlan["operations"] = search.items.map(
			(item, index) => ({
				type: "insert_library_audio_element",
				libraryAssetId: item.id,
				name: item.name,
				startTime: mediaTime({ ticks: index * 240_000 }),
				duration: mediaTime({ ticks: item.durationTicks }),
			}),
		);
		const audioOnlyPlan: AiEditPlan = {
			title: "Sound design",
			summary: "Two searched SFX",
			operations: audioOperations,
		};
		expect(runtime.getCompletionErrors(audioOnlyPlan).join("\n")).toContain(
			"explicitly requires VFX",
		);

		const completePlan: AiEditPlan = {
			...audioOnlyPlan,
			operations: [
				...audioOperations,
				{
					type: "add_clip_effect",
					trackId: "main",
					elementId: "hero-clip",
					effectType: "blur",
				},
			],
		};
		expect(runtime.getCompletionErrors(completePlan)).toEqual([]);
	});
});

function authorizeForTest({
	names,
	grantedPermissions,
}: {
	names: string[];
	grantedPermissions: string[];
}) {
	return names.map((name) => {
		const risk =
			name === "timeline.edit_source" ||
			name === "timeline.edit_full_source" ||
			name === "timeline.stage_operations"
				? ("edit" as const)
				: name === "playback.control" ||
					  name === "scene.activate" ||
					  name === "export.cancel" ||
					  name === "transcription.cancel"
					? ("control" as const)
					: ("read" as const);
		const requiredPermissions =
			name === "web.research"
				? (["network"] as const)
				: name === "timeline.list_media" || name === "library.search"
					? (["media"] as const)
					: name === "preview.capture_frame" ||
						  name === "preview.capture_range_frames"
						? (["preview"] as const)
						: name === "playback.control" ||
							  name === "scene.activate" ||
							  name === "export.cancel" ||
							  name === "transcription.cancel"
							? (["app_control"] as const)
							: name === "bookmarks.list" ||
								  name === "captions.get_source" ||
								  (name.startsWith("timeline.") &&
										name !== "timeline.propose_edit_plan")
								? (["layers"] as const)
								: ([] as const);
		const allowed = requiredPermissions.every((permission) =>
			grantedPermissions.includes(permission),
		);
		return {
			name,
			allowed,
			executionPolicy: allowed
				? name === "web.research"
					? ("confirm" as const)
					: risk === "edit"
						? ("review" as const)
						: ("immediate" as const)
				: ("denied" as const),
			reason: allowed ? "test grant" : "missing test grant",
			risk,
			readOnly: risk === "read",
			idempotent: risk !== "edit",
			openWorld: name === "web.research",
			requiredPermissions: [...requiredPermissions],
		};
	});
}

async function readEntireFullSource(runtime: {
	executeTool: (toolCall: {
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}) => Promise<unknown>;
}): Promise<{
	baseRevision: string;
	items: Array<{ lineNumber: number; text: string }>;
}> {
	const page = (await runtime.executeTool({
		id: "read-entire-full-source",
		name: "timeline.read_full_source",
		arguments: { cursor: 0, limit: 100 },
	})) as {
		baseRevision: string;
		items: Array<{ lineNumber: number; text: string }>;
		nextCursor: number | null;
	};
	expect(page.nextCursor).toBeNull();
	return page;
}

function createFullSourceEditorFixture({
	insideContent = "Inside copy",
}: {
	insideContent?: string;
} = {}): { editor: EditorCore } {
	const scene = {
		id: "scene-1",
		name: "Main scene",
		isMain: true,
		createdAt: new Date("2026-07-01T10:00:00.000Z"),
		updatedAt: new Date("2026-07-02T11:30:00.000Z"),
		bookmarks: [],
		tracks: {
			overlay: [
				{
					id: "text-track",
					name: "Titles",
					type: "text",
					hidden: false,
					elements: [
						{
							id: "inside-title",
							name: "Inside title",
							type: "text",
							startTime: 120_000,
							duration: 120_000,
							trimStart: 0,
							trimEnd: 0,
							params: { content: insideContent },
						},
						{
							id: "outside-title",
							name: "Outside title",
							type: "text",
							startTime: 480_000,
							duration: 120_000,
							trimStart: 0,
							trimEnd: 0,
							params: { content: "Outside copy" },
						},
					],
				},
			],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
			audio: [],
			order: ["text-track", "main"],
		},
	};
	const project = {
		metadata: {
			id: "project-1",
			name: "Project",
			duration: 0,
			createdAt: new Date("2026-07-01T10:00:00.000Z"),
			updatedAt: new Date("2026-07-02T11:30:00.000Z"),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: 1,
	};
	const editor = {
		scenes: {
			getActiveSceneOrNull: () => scene,
			getScenes: () => [scene],
		},
		media: { getAssets: () => [] },
		project: {
			getActive: () => project,
			getActiveOrNull: () => project,
			getExportState: () => ({
				isExporting: false,
				progress: 0,
				result: null,
				options: null,
			}),
		},
		transcription: {
			getState: () => ({
				task: {
					taskId: null,
					kind: "transcription",
					status: "idle",
					progressBasisPoints: 0,
					phase: "idle",
				},
				language: "auto",
				sceneId: null,
				insertedTrackIds: [],
			}),
		},
	} as unknown as EditorCore;
	return { editor };
}
