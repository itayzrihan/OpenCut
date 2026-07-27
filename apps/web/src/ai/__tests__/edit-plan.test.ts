import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene } from "@/timeline";
import { CUSTOM_AI_EFFECT_TYPE } from "@/effects/custom-ai-effect";
import type { MediaTime } from "@/wasm";
import type { EditorCore } from "@/core";
import type { TProject, TProjectSettings } from "@/project/types";
import type { TimelineDocumentV2MutationScopeValidator } from "../timeline-document-v2-scope";

function canonicalizeTimelineSourceDocumentForTest({ json }: { json: string }) {
	try {
		const formattedJson = JSON.stringify(
			sortJsonValue(JSON.parse(json)),
			null,
			2,
		);
		let hash = 2_166_136_261;
		for (let index = 0; index < formattedJson.length; index += 1) {
			hash ^= formattedJson.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619);
		}
		return {
			valid: true,
			formattedJson,
			baseRevision: `test:${(hash >>> 0).toString(16)}`,
			diagnostics: [],
		};
	} catch {
		return {
			valid: false,
			formattedJson: "",
			baseRevision: "",
			diagnostics: [
				{
					code: "invalid_json",
					path: "$",
					message: "Timeline Source must be valid JSON",
				},
			],
		};
	}
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, sortJsonValue(child)]),
	);
}

const validateTimelineSourceV2ScopeForTest: TimelineDocumentV2MutationScopeValidator =
	({ beforeJson, afterJson, selectedRange }) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the adapter supplies canonical test documents.
		const before = JSON.parse(beforeJson) as SourceScopeDocumentForTest;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the adapter supplies canonical test documents.
		const after = JSON.parse(afterJson) as SourceScopeDocumentForTest;
		const diagnostics: Array<{ code: string; path: string; message: string }> =
			[];

		if (before.scene.id !== after.scene.id) {
			diagnostics.push({
				code: "scene_id_changed",
				path: "$.scene.id",
				message: "Timeline Source cannot change the active scene id",
			});
		}
		if (before.scene.isMain !== after.scene.isMain) {
			diagnostics.push({
				code: "scene_role_changed",
				path: "$.scene.isMain",
				message:
					"Timeline Source cannot change whether the scene is the main scene",
			});
		}
		if (!selectedRange) {
			return { valid: diagnostics.length === 0, diagnostics };
		}

		if (
			!sameJson({ left: before.projectSettings, right: after.projectSettings })
		) {
			diagnostics.push({
				code: "range_project_structure_changed",
				path: "$.projectSettings",
				message: "A range-scoped edit cannot change project settings",
			});
		}
		const { tracks: _beforeTracks, ...beforeSceneFields } = before.scene;
		const { tracks: _afterTracks, ...afterSceneFields } = after.scene;
		if (!sameJson({ left: beforeSceneFields, right: afterSceneFields })) {
			diagnostics.push({
				code: "range_scene_structure_changed",
				path: "$.scene",
				message:
					"A range-scoped edit cannot change scene metadata or bookmarks",
			});
		}
		if (
			!sameJson({
				left: before.scene.tracks.map(
					({ elements: _elements, ...track }) => track,
				),
				right: after.scene.tracks.map(
					({ elements: _elements, ...track }) => track,
				),
			})
		) {
			diagnostics.push({
				code: "range_track_structure_changed",
				path: "$.scene.tracks",
				message:
					"A range-scoped edit cannot add, remove, reorder, or modify tracks",
			});
		}

		const beforeElements = collectSourceScopeElements(before);
		const afterElements = collectSourceScopeElements(after);
		for (const id of new Set([
			...beforeElements.keys(),
			...afterElements.keys(),
		])) {
			const beforeEntry = beforeElements.get(id);
			const afterEntry = afterElements.get(id);
			if (
				beforeEntry &&
				afterEntry &&
				beforeEntry.trackId === afterEntry.trackId &&
				sameJson({ left: beforeEntry.element, right: afterEntry.element })
			) {
				continue;
			}
			const entries = [beforeEntry, afterEntry].filter(
				(entry): entry is SourceScopeElementEntryForTest => Boolean(entry),
			);
			if (
				entries.every(({ element }) =>
					containsSourceScopeElement({ element, range: selectedRange }),
				)
			) {
				continue;
			}
			const kind = beforeEntry
				? afterEntry
					? "changed"
					: "deleted"
				: "inserted";
			diagnostics.push({
				code: "range_element_out_of_scope",
				path: afterEntry?.path ?? beforeEntry?.path ?? "$.scene.tracks",
				message: `Element "${id}" was ${kind} outside the selected range`,
			});
		}

		return { valid: diagnostics.length === 0, diagnostics };
	};

interface SourceScopeDocumentForTest {
	projectSettings: unknown;
	scene: {
		id: string;
		isMain: boolean;
		tracks: Array<{
			id: string;
			elements: Array<{ id: string; startTime: number; duration: number }>;
			[key: string]: unknown;
		}>;
		[key: string]: unknown;
	};
}

interface SourceScopeElementEntryForTest {
	trackId: string;
	path: string;
	element: { id: string; startTime: number; duration: number };
}

function collectSourceScopeElements(
	document: SourceScopeDocumentForTest,
): Map<string, SourceScopeElementEntryForTest> {
	const elements = new Map<string, SourceScopeElementEntryForTest>();
	for (const [trackIndex, track] of document.scene.tracks.entries()) {
		for (const [elementIndex, element] of track.elements.entries()) {
			elements.set(element.id, {
				trackId: track.id,
				element,
				path: `$.scene.tracks[${trackIndex}].elements[${elementIndex}]`,
			});
		}
	}
	return elements;
}

function containsSourceScopeElement({
	element,
	range,
}: {
	element: { startTime: number; duration: number };
	range: { startTime: number; duration: number };
}): boolean {
	return (
		element.startTime >= range.startTime &&
		element.startTime + element.duration <= range.startTime + range.duration
	);
}

function sameJson({ left, right }: { left: unknown; right: unknown }): boolean {
	return (
		JSON.stringify(sortJsonValue(left)) === JSON.stringify(sortJsonValue(right))
	);
}

mock.module("../timeline-document-v2-canonicalizer", () => ({
	defaultTimelineDocumentV2Canonicalizer:
		canonicalizeTimelineSourceDocumentForTest,
}));

type MockProvenanceDescriptor = {
	operationId?: string;
	operationType: string;
	timing?: { startTime?: number; duration?: number; pointTime?: number };
	refs: Record<string, string | undefined>;
};

function buildMockAiEditPlanRecord(options: {
	planId?: string;
	title: string;
	summary?: string;
	appliedAt?: string;
	sceneId?: string;
	defaultRange?: { startTime?: number; duration?: number; pointTime?: number };
	operations: MockProvenanceDescriptor[];
}) {
	const keyframes = options.operations.filter((operation) =>
		["upsert_keyframe", "remove_keyframe"].includes(operation.operationType),
	);
	const coalesceKeyframes =
		keyframes.length === options.operations.length && keyframes.length > 0;
	const buildAnchor = (operation: MockProvenanceDescriptor) => {
		const timing = operation.timing ?? options.defaultRange;
		if (timing?.pointTime !== undefined) {
			return { kind: "point", time: timing.pointTime };
		}
		if (timing?.startTime !== undefined && (timing.duration ?? 0) > 0) {
			return {
				kind: "range",
				startTime: timing.startTime,
				duration: timing.duration ?? 0,
			};
		}
		return { kind: "project" };
	};
	const layers = coalesceKeyframes
		? [
				{
					id: "coalesced-keyframes",
					operationType: keyframes[0]?.operationType ?? "upsert_keyframe",
					label: `Animate ${keyframes[0]?.refs.propertyPath ?? "property"}`,
					anchor: {
						kind: "range",
						startTime: Math.min(
							...keyframes.map((operation) => operation.timing?.pointTime ?? 0),
						),
						duration:
							Math.max(
								...keyframes.map(
									(operation) => operation.timing?.pointTime ?? 0,
								),
							) -
							Math.min(
								...keyframes.map(
									(operation) => operation.timing?.pointTime ?? 0,
								),
							),
					},
					refs: keyframes.map((operation) => operation.refs),
					operationIds: keyframes.map(
						(operation) => operation.operationId ?? "operation",
					),
					operationCount: keyframes.length,
					tombstone: keyframes.every(
						(operation) => operation.operationType === "remove_keyframe",
					),
				},
			]
		: options.operations.map((operation, index) => ({
				id: `layer-${index + 1}`,
				operationType: operation.operationType,
				label: operation.operationType,
				anchor: buildAnchor(operation),
				refs: Object.keys(operation.refs).length > 0 ? [operation.refs] : [],
				operationIds: [operation.operationId ?? `operation-${index + 1}`],
				operationCount: 1,
				tombstone: operation.operationType.startsWith("remove_"),
			}));
	return {
		schemaVersion: 1,
		id: options.planId ?? "plan-record",
		title: options.title,
		summary: options.summary ?? "",
		appliedAt: options.appliedAt,
		sceneId: options.sceneId,
		layers,
		operationCount: options.operations.length,
		truncatedOperationCount: 0,
	};
}

mock.module("../edit-provenance-builder", () => ({
	defaultAiEditPlanRecordBuilder: buildMockAiEditPlanRecord,
}));

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
	roundFrameTime: ({ time }: { time: number }) => time,
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
	buildAiEditPlanRecord: buildMockAiEditPlanRecord,
	canonicalizeTimelineSourceDocument: canonicalizeTimelineSourceDocumentForTest,
}));

mock.module("@/services/storage/service", () => ({
	storageService: {
		saveCommandHistory: async () => undefined,
	},
}));

let applyAiEditPlan: typeof import("@/ai/edit-plan").applyAiEditPlan;
let buildCustomEditEffectElement: typeof import("@/ai/edit-plan").buildCustomEditEffectElement;
let buildCustomEditEffectParams: typeof import("@/ai/edit-plan").buildCustomEditEffectParams;
let extractAiEditPlanFromText: typeof import("@/ai/edit-plan").extractAiEditPlanFromText;
let validateAiEditPlan: typeof import("@/ai/edit-plan").validateAiEditPlan;
let buildAiEditPlanProvenanceRecord: typeof import("@/ai/edit-provenance").buildAiEditPlanProvenanceRecord;
let buildTimelineDocumentV2: typeof import("@/ai/timeline-document-v2").buildTimelineDocumentV2;
let CommandManager: typeof import("@/core/managers/commands").CommandManager;

beforeAll(async () => {
	({
		applyAiEditPlan,
		buildCustomEditEffectElement,
		buildCustomEditEffectParams,
		extractAiEditPlanFromText,
		validateAiEditPlan,
	} = await import("@/ai/edit-plan"));
	({ buildAiEditPlanProvenanceRecord } = await import("@/ai/edit-provenance"));
	({ buildTimelineDocumentV2 } = await import("@/ai/timeline-document-v2"));
	({ CommandManager } = await import("@/core/managers/commands"));
});

const t = (time: number) => {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixtures use integer ticks.
	return time as MediaTime;
};

const tracks: SceneTracks = {
	overlay: [
		{
			id: "text",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [
				{
					id: "inside",
					type: "text",
					name: "inside",
					startTime: t(100),
					duration: t(100),
					trimStart: t(0),
					trimEnd: t(0),
					params: { text: "inside" },
					effects: [
						{
							id: "effect-blur",
							type: "blur",
							enabled: true,
							params: { intensity: 15 },
						},
					],
				},
				{
					id: "outside",
					type: "text",
					name: "outside",
					startTime: t(500),
					duration: t(100),
					trimStart: t(0),
					trimEnd: t(0),
					params: { text: "outside" },
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
		elements: [],
	},
	audio: [
		{
			id: "audio-track",
			name: "Audio",
			type: "audio",
			muted: false,
			elements: [
				{
					id: "audio",
					type: "audio",
					name: "audio",
					sourceType: "upload",
					mediaId: "media-audio",
					startTime: t(100),
					duration: t(100),
					trimStart: t(0),
					trimEnd: t(0),
					params: { volume: 0, muted: false },
				},
			],
		},
	],
};

function provenanceScene(): TScene {
	return {
		id: "scene-main",
		name: "Main scene",
		isMain: true,
		tracks,
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

function timelineSourceProjectSettings(): TProjectSettings {
	return {
		fps: { numerator: 30, denominator: 1 },
		canvasSize: { width: 1920, height: 1080 },
		background: { type: "color", color: "#000000" },
	};
}

interface EditableTimelineSourceForTest {
	projectSettings: TProjectSettings;
	scene: {
		name: string;
		tracks: Array<{
			id: string;
			elements: Array<{
				id: string;
				name: string;
				params: Record<string, unknown>;
			}>;
		}>;
	};
}

function buildFullSourceEditForTest({
	scene = provenanceScene(),
	projectSettings = timelineSourceProjectSettings(),
	mutate,
}: {
	scene?: TScene;
	projectSettings?: TProjectSettings;
	mutate: (document: EditableTimelineSourceForTest) => void;
}) {
	const current = buildTimelineDocumentV2({
		project: { settings: projectSettings },
		scene,
	});
	if (!current.valid) {
		throw new Error(
			`Failed to build Timeline Source test fixture: ${current.diagnostics
				.map((diagnostic) => diagnostic.message)
				.join("; ")}`,
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the builder produced this canonical fixture shape.
	const document = JSON.parse(
		current.formattedText,
	) as EditableTimelineSourceForTest;
	mutate(document);
	const edited = canonicalizeTimelineSourceDocumentForTest({
		json: JSON.stringify(document),
	});
	if (!edited.valid) {
		throw new Error(
			"Failed to canonicalize edited Timeline Source test fixture",
		);
	}
	return { current, document: edited.formattedJson, projectSettings, scene };
}

function getSourceElementForTest({
	document,
	elementId,
}: {
	document: EditableTimelineSourceForTest;
	elementId: string;
}): EditableTimelineSourceForTest["scene"]["tracks"][number]["elements"][number] {
	for (const track of document.scene.tracks) {
		const element = track.elements.find(
			(candidate) => candidate.id === elementId,
		);
		if (element) return element;
	}
	throw new Error(`Missing Timeline Source test element ${elementId}`);
}

describe("AI edit provenance bridge", () => {
	test("records shared-library audio with its exact timeline range", () => {
		const record = buildAiEditPlanProvenanceRecord({
			planId: "plan-shared-audio",
			appliedAt: "2026-07-13T10:00:00.000Z",
			scene: provenanceScene(),
			plan: {
				title: "Add whoosh",
				summary: "Add an impact sound",
				operations: [
					{
						type: "insert_library_audio_element",
						libraryAssetId: "audio-1",
						name: "Whoosh impact",
						startTime: t(240_000),
						duration: t(150_000),
					},
				],
			},
		});

		expect(record.layers).toMatchObject([
			{
				operationType: "insert_library_audio_element",
				anchor: {
					kind: "range",
					startTime: t(240_000),
					duration: t(150_000),
				},
			},
		]);
	});

	test("coalesces keyframes while preserving timeline timing and refs", () => {
		const record = buildAiEditPlanProvenanceRecord({
			planId: "plan-keyframes",
			appliedAt: "2026-07-13T10:00:00.000Z",
			scene: provenanceScene(),
			plan: {
				title: "Animate title",
				summary: "Two opacity beats",
				operations: [
					{
						type: "upsert_keyframe",
						trackId: "text",
						elementId: "inside",
						propertyPath: "opacity",
						keyframeId: "key-1",
						time: t(10),
						value: 0,
					},
					{
						type: "upsert_keyframe",
						trackId: "text",
						elementId: "inside",
						propertyPath: "opacity",
						keyframeId: "key-2",
						time: t(40),
						value: 1,
					},
				],
			},
		});

		expect(record).toMatchObject({
			schemaVersion: 1,
			id: "plan-keyframes",
			operationCount: 2,
			truncatedOperationCount: 0,
			layers: [
				{
					operationCount: 2,
					anchor: { kind: "range", startTime: t(110), duration: t(30) },
					refs: [
						{
							sceneId: "scene-main",
							trackId: "text",
							elementId: "inside",
							keyframeId: "key-1",
							propertyPath: "opacity",
						},
						{
							sceneId: "scene-main",
							trackId: "text",
							elementId: "inside",
							keyframeId: "key-2",
							propertyPath: "opacity",
						},
					],
				},
			],
		});
	});

	test("appends provenance inside the transaction snapshots for undo and redo", () => {
		let activeProject: TProject = {
			metadata: {
				id: "project-1",
				name: "Project",
				duration: t(600),
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			scenes: [provenanceScene()],
			currentSceneId: "scene-main",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
			aiEditHistory: [],
			version: 1,
		};
		const selection = {
			selectedElements: [],
			selectedTextWords: [],
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		};
		const editorRecord: Record<string, unknown> = {
			project: {
				getActive: () => activeProject,
				getActiveOrNull: () => activeProject,
				setActiveProject: ({ project }: { project: TProject }) => {
					activeProject = project;
				},
			},
			scenes: {
				getActiveSceneOrNull: () =>
					activeProject.scenes.find(
						(scene) => scene.id === activeProject.currentSceneId,
					) ?? null,
				getScenes: () => activeProject.scenes,
				initializeScenes: () => undefined,
			},
			selection: {
				getSnapshot: () => selection,
				restoreSnapshot: () => undefined,
			},
			save: {
				pause: () => undefined,
				resume: () => undefined,
				markDirty: () => undefined,
			},
		};
		const editor = editorRecord as unknown as EditorCore;
		const command = new CommandManager(editor);
		editorRecord.command = command;

		applyAiEditPlan({
			editor,
			range: { startTime: t(90), endTime: t(220) },
			plan: {
				title: "Change canvas",
				summary: "Use a vertical canvas",
				operations: [
					{
						type: "set_project_settings",
						canvasSize: { width: 1080, height: 1920 },
					},
				],
			},
		});

		expect(activeProject.settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(activeProject.aiEditHistory).toHaveLength(1);
		expect(command.canUndo()).toBe(true);

		command.undo();
		expect(activeProject.settings.canvasSize).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(activeProject.aiEditHistory).toEqual([]);

		command.redo();
		expect(activeProject.settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(activeProject.aiEditHistory).toHaveLength(1);
	});
});

describe("AI edit plan validation", () => {
	test("adds creative coverage warnings to an under-resolved reviewed plan", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Epic cinematic VFX and SFX pass",
				summary: "Make the selected moment amazing",
				operations: [
					{
						type: "update_element",
						trackId: "text",
						elementId: "inside",
						patch: { name: "Hero title" },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(true);
		expect(result.plan?.notes?.join("\n")).toContain(
			"broad creative treatment is unusually minimal",
		);
		expect(result.plan?.notes?.join("\n")).toContain(
			"calls for SFX or sound design",
		);
		expect(result.plan?.notes?.join("\n")).toContain("calls for VFX");
	});

	test("does not duplicate creative warnings when a plan is revalidated", () => {
		const firstValidation = validateAiEditPlan({
			value: {
				title: "Epic cinematic transition pass",
				summary: "Repeat the same transition across the selected sequence",
				operations: Array.from({ length: 8 }, (_, index) => ({
					type: "apply_transition" as const,
					trackId: "main",
					elementId: `clip-${index}`,
					presetId: "fade",
					side: "in" as const,
				})),
			},
			tracks,
		});
		expect(firstValidation.plan).not.toBeNull();

		const secondValidation = validateAiEditPlan({
			value: firstValidation.plan,
			tracks,
		});
		const repetitionWarning =
			"Creative quality warning: most transition operations repeat the same preset and side. Review whether each repetition serves a distinct content beat.";

		expect(
			secondValidation.plan?.notes?.filter(
				(note) => note === repetitionWarning,
			),
		).toHaveLength(1);
	});

	test("extracts an edit plan from double-encoded JSON text", () => {
		const plan = {
			title: "Update text",
			summary: "Change two text layers",
			operations: [
				{
					type: "update_element",
					trackId: "text",
					elementId: "inside",
					params: { content: "HELLO" },
				},
			],
		};

		const extracted = extractAiEditPlanFromText(
			JSON.stringify(JSON.stringify(plan)),
		);

		expect(extracted).toEqual({
			...plan,
			operations: [
				{
					...plan.operations[0],
					patch: { params: { content: "HELLO" } },
				},
			],
		});
	});

	test("normalizes update-element params shorthand before validation", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Update word",
				summary: "Change one text element",
				operations: [
					{
						type: "update_element",
						trackId: "text",
						elementId: "inside",
						params: { content: "HELLO" },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(true);
		expect(result.plan?.operations[0]).toMatchObject({
			type: "update_element",
			patch: { params: { content: "HELLO" } },
		});
	});

	test("rejects identity and timing fields in generic element patches", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Unsafe patch",
				summary: "",
				operations: [
					{
						type: "update_element",
						trackId: "text",
						elementId: "inside",
						patch: { id: "replacement", startTime: t(0) },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors.join(" ")).toContain("cannot patch id");
		expect(result.errors.join(" ")).toContain("cannot patch startTime");
	});

	test("accepts a full Timeline Source edit confined to the reviewed range", () => {
		const fixture = buildFullSourceEditForTest({
			mutate: (document) => {
				getSourceElementForTest({ document, elementId: "inside" }).params.text =
					"changed by full source";
			},
		});
		const range = { startTime: t(90), endTime: t(220) };
		const result = validateAiEditPlan({
			value: {
				title: "Apply exact source edit",
				summary: "Change one in-range title",
				operations: [
					{
						type: "apply_timeline_source_v2",
						baseRevision: fixture.current.baseRevision,
						document: fixture.document,
						scope: range,
					},
				],
			},
			tracks: fixture.scene.tracks,
			range,
			scenes: [fixture.scene],
			activeSceneId: fixture.scene.id,
			projectSettings: fixture.projectSettings,
			timelineSourceV2ScopeValidator: validateTimelineSourceV2ScopeForTest,
		});

		expect(result.success).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("rejects stale, no-op, and out-of-range full Timeline Source edits", () => {
		const noOpScene = provenanceScene();
		const projectSettings = timelineSourceProjectSettings();
		const current = buildTimelineDocumentV2({
			project: { settings: projectSettings },
			scene: noOpScene,
		});
		const range = { startTime: t(90), endTime: t(220) };
		const noOp = validateAiEditPlan({
			value: {
				title: "No-op source",
				summary: "",
				operations: [
					{
						type: "apply_timeline_source_v2",
						baseRevision: current.baseRevision,
						document: current.formattedText,
						scope: range,
					},
				],
			},
			tracks: noOpScene.tracks,
			range,
			scenes: [noOpScene],
			activeSceneId: noOpScene.id,
			projectSettings,
			timelineSourceV2ScopeValidator: validateTimelineSourceV2ScopeForTest,
		});
		const outside = buildFullSourceEditForTest({
			scene: noOpScene,
			projectSettings,
			mutate: (document) => {
				getSourceElementForTest({ document, elementId: "outside" }).name =
					"changed outside selection";
			},
		});
		const staleAndOutside = validateAiEditPlan({
			value: {
				title: "Unsafe source",
				summary: "",
				operations: [
					{
						type: "apply_timeline_source_v2",
						baseRevision: "test:stale",
						document: outside.document,
						scope: range,
					},
				],
			},
			tracks: noOpScene.tracks,
			range,
			scenes: [noOpScene],
			activeSceneId: noOpScene.id,
			projectSettings,
			timelineSourceV2ScopeValidator: validateTimelineSourceV2ScopeForTest,
		});

		expect(noOp.success).toBe(false);
		expect(noOp.errors.join(" ")).toContain("no persistent timeline change");
		expect(staleAndOutside.success).toBe(false);
		expect(staleAndOutside.errors.join(" ")).toContain("stale");
		expect(staleAndOutside.errors.join(" ")).toContain(
			"changed outside the selected range",
		);
	});

	test("refuses to apply full source when its declared scope omits the active range", () => {
		const fixture = buildFullSourceEditForTest({
			mutate: (document) => {
				getSourceElementForTest({ document, elementId: "inside" }).name =
					"changed";
			},
		});

		expect(() =>
			applyAiEditPlan({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- scope validation rejects before editor access.
				editor: {} as EditorCore,
				range: { startTime: t(90), endTime: t(220) },
				plan: {
					title: "Missing scope",
					summary: "",
					operations: [
						{
							type: "apply_timeline_source_v2",
							baseRevision: fixture.current.baseRevision,
							document: fixture.document,
						},
					],
				},
			}),
		).toThrow("scope does not match the active selected range");
	});

	test("accepts operations inside active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Update word",
				summary: "Change one text element",
				operations: [
					{
						type: "update_element",
						trackId: "text",
						elementId: "inside",
						patch: { params: { text: "changed" } },
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(true);
		expect(result.plan?.operations).toHaveLength(1);
	});

	test("rejects operations outside active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Bad edit",
				summary: "",
				operations: [
					{
						type: "delete_element",
						trackId: "text",
						elementId: "outside",
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("outside the selected range");
	});

	test("accepts inserted text fully inside active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Add caption",
				summary: "",
				operations: [
					{
						type: "insert_text_element",
						content: "New caption",
						startTime: t(100),
						duration: t(40),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(true);
		expect(result.plan?.operations).toHaveLength(1);
	});

	test("rejects inserted text outside active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Add late caption",
				summary: "",
				operations: [
					{
						type: "insert_text_element",
						content: "Late caption",
						startTime: t(200),
						duration: t(40),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("outside the selected range");
	});

	test("rejects inserted text on non-text tracks", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Add caption to main",
				summary: "",
				operations: [
					{
						type: "insert_text_element",
						trackId: "main",
						content: "Wrong track",
						startTime: t(100),
						duration: t(40),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("not a text track");
	});

	test("accepts custom edit specs on elements inside the active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Attach custom animation",
				summary: "Host a Hyperframes-style animation spec",
				operations: [
					{
						type: "attach_custom_edit",
						trackId: "text",
						elementId: "inside",
						label: "Blur zoom entrance",
						kind: "animation",
						intent: "Animate the word with a blurred zoom-in.",
						startTime: t(100),
						duration: t(40),
						spec: {
							method: "fromTo",
							duration: 0.45,
							from: { opacity: 0, scale: 1.4, blur: 16 },
							to: { opacity: 1, scale: 1, blur: 0 },
						},
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(true);
		expect(result.plan?.operations[0]).toMatchObject({
			type: "attach_custom_edit",
			kind: "animation",
			startTime: t(100),
			duration: t(40),
		});
	});

	test("rejects custom edit layer timing outside the active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Attach custom animation",
				summary: "",
				operations: [
					{
						type: "attach_custom_edit",
						trackId: "text",
						elementId: "inside",
						label: "Long effect",
						startTime: t(100),
						duration: t(200),
						spec: { effect: "blur" },
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("timing is outside");
	});

	test("rejects custom edit specs outside the active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Attach late custom animation",
				summary: "",
				operations: [
					{
						type: "attach_custom_edit",
						trackId: "text",
						elementId: "outside",
						label: "Late effect",
						spec: { effect: "shake" },
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("outside the selected range");
	});

	test("rejects missing element references without an active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Missing target",
				summary: "",
				operations: [
					{
						type: "delete_element",
						trackId: "text",
						elementId: "missing",
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("missing element");
	});

	test("validates staged scene, project-setting, and bookmark operations", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Organize project",
				summary: "Add a scene and annotate the active one",
				operations: [
					{ type: "create_scene", name: "Alternate cut" },
					{
						type: "rename_scene",
						sceneId: "scene-main",
						name: "Primary cut",
					},
					{
						type: "set_project_settings",
						canvasSize: { width: 1080, height: 1920 },
					},
					{
						type: "update_bookmark",
						time: t(120_000),
						note: "Opening beat",
					},
				],
			},
			tracks,
			scenes: [
				{
					id: "scene-main",
					name: "Main scene",
					isMain: true,
					tracks,
					bookmarks: [{ time: t(120_000) }],
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
			activeSceneId: "scene-main",
			projectSettings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
		});

		expect(result.success).toBe(true);
		expect(result.plan?.operations).toHaveLength(4);
	});

	test("rejects main-scene deletion and invalid bookmark targets", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Unsafe organization",
				summary: "",
				operations: [
					{ type: "delete_scene", sceneId: "scene-main" },
					{ type: "remove_bookmark", time: t(240_000) },
				],
			},
			tracks,
			scenes: [
				{
					id: "scene-main",
					name: "Main scene",
					isMain: true,
					tracks,
					bookmarks: [{ time: t(120_000) }],
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			],
			activeSceneId: "scene-main",
			projectSettings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
		});

		expect(result.success).toBe(false);
		expect(result.errors.join(" ")).toContain("cannot delete the main scene");
		expect(result.errors.join(" ")).toContain("missing bookmark");
	});

	test("requires export tasks to be standalone and idle", () => {
		const valid = validateAiEditPlan({
			value: {
				title: "Export",
				summary: "Render the project",
				operations: [
					{
						type: "start_export_task",
						format: "mp4",
						quality: "high",
						includeAudio: true,
					},
				],
			},
			tracks,
			exportState: { isExporting: false, progress: 0, result: null },
		});
		const invalid = validateAiEditPlan({
			value: {
				title: "Mixed export",
				summary: "",
				operations: [
					{
						type: "start_export_task",
						format: "webm",
						quality: "medium",
					},
					{ type: "create_scene", name: "Too late" },
				],
			},
			tracks,
			range: { startTime: t(0), endTime: t(120_000) },
			exportState: { isExporting: true, progress: 0.5, result: null },
		});

		expect(valid.success).toBe(true);
		expect(invalid.success).toBe(false);
		expect(invalid.errors.join(" ")).toContain("only operation");
		expect(invalid.errors.join(" ")).toContain("range editing");
		expect(invalid.errors.join(" ")).toContain("already running");
	});

	test("requires transcription tasks to be standalone, idle, and supported", () => {
		const valid = validateAiEditPlan({
			value: {
				title: "Generate captions",
				summary: "Transcribe the active scene",
				operations: [{ type: "start_transcription_task", language: "en" }],
			},
			tracks,
			transcriptionState: {
				task: {
					taskId: undefined,
					kind: undefined,
					status: "idle",
					progressBasisPoints: 0,
					phase: undefined,
					error: undefined,
				},
				insertedTrackIds: [],
			},
		});
		const invalid = validateAiEditPlan({
			value: {
				title: "Invalid transcription",
				summary: "",
				operations: [
					{ type: "start_transcription_task", language: "not-a-language" },
					{ type: "create_scene", name: "Mixed task" },
				],
			},
			tracks,
			range: { startTime: t(0), endTime: t(120_000) },
			transcriptionState: {
				task: {
					taskId: "task-1",
					kind: "transcription",
					status: "running",
					progressBasisPoints: 2_000,
					phase: "transcribing",
					error: undefined,
				},
				insertedTrackIds: [],
			},
		});

		expect(valid.success).toBe(true);
		expect(invalid.success).toBe(false);
		expect(invalid.errors.join(" ")).toContain("only operation");
		expect(invalid.errors.join(" ")).toContain("range editing");
		expect(invalid.errors.join(" ")).toContain("already running");
		expect(invalid.errors.join(" ")).toContain("Unsupported");
	});

	test("rejects moves to missing target tracks", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Move text",
				summary: "",
				operations: [
					{
						type: "move_element",
						sourceTrackId: "text",
						targetTrackId: "missing-track",
						elementId: "inside",
						startTime: t(100),
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("missing target track");
	});

	test("rejects moves to incompatible target track types", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Move text to audio",
				summary: "",
				operations: [
					{
						type: "move_element",
						sourceTrackId: "text",
						targetTrackId: "audio-track",
						elementId: "inside",
						startTime: t(100),
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain(
			"text elements cannot be placed on audio",
		);
	});

	test("rejects moved timing outside the active range", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Move text late",
				summary: "",
				operations: [
					{
						type: "move_element",
						sourceTrackId: "text",
						targetTrackId: "text",
						elementId: "inside",
						startTime: t(180),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("target timing is outside");
	});

	test("rejects unsupported keyframe property paths", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Bad keyframe",
				summary: "",
				operations: [
					{
						type: "upsert_keyframe",
						trackId: "text",
						elementId: "inside",
						propertyPath: "not.a.real.path",
						time: t(10),
						value: 1,
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("unsupported animation path");
	});

	test("treats keyframe operation time as element-local for range checks", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Fade text",
				summary: "",
				operations: [
					{
						type: "upsert_keyframe",
						trackId: "text",
						elementId: "inside",
						propertyPath: "opacity",
						time: t(10),
						value: 0.5,
					},
				],
			},
			tracks,
			range: { startTime: t(105), endTime: t(120) },
		});

		expect(result.errors).not.toContain(
			"upsert_keyframe time is outside the selected range",
		);
	});

	test("rejects custom edit specs on non-visual elements", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Audio effect",
				summary: "",
				operations: [
					{
						type: "attach_custom_edit",
						trackId: "audio-track",
						elementId: "audio",
						label: "Visual shake",
						spec: { effect: "shake" },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("not a visual element");
	});

	test("accepts clip effect updates when the referenced effect exists", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Adjust blur",
				summary: "",
				operations: [
					{
						type: "update_clip_effect_params",
						trackId: "text",
						elementId: "inside",
						effectId: "effect-blur",
						params: { intensity: 35 },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(true);
	});

	test("rejects clip effect updates when the referenced effect is missing", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Adjust blur",
				summary: "",
				operations: [
					{
						type: "update_clip_effect_params",
						trackId: "text",
						elementId: "inside",
						effectId: "missing-effect",
						params: { intensity: 35 },
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("missing effect");
	});

	test("validates effect-stack controls and background removal targets", () => {
		const effectResult = validateAiEditPlan({
			value: {
				title: "Control blur",
				summary: "",
				operations: [
					{
						type: "set_clip_effect_enabled",
						trackId: "text",
						elementId: "inside",
						effectId: "effect-blur",
						enabled: false,
					},
					{
						type: "reorder_clip_effect",
						trackId: "text",
						elementId: "inside",
						fromIndex: 0,
						toIndex: 0,
					},
				],
			},
			tracks,
		});
		const backgroundResult = validateAiEditPlan({
			value: {
				title: "Remove background",
				summary: "",
				operations: [
					{
						type: "set_background_removal",
						trackId: "text",
						elementId: "inside",
						enabled: true,
					},
				],
			},
			tracks,
		});

		expect(effectResult.success).toBe(true);
		expect(backgroundResult.success).toBe(false);
		expect(backgroundResult.errors[0]).toContain("not a video element");
	});

	test("builds custom effect params for custom edit operations", () => {
		const params = buildCustomEditEffectParams({
			operation: {
				type: "attach_custom_edit",
				trackId: "text",
				elementId: "inside",
				label: "Explode letters",
				kind: "animation",
				intent: "Explode each letter outward.",
				startTime: t(100),
				duration: t(50),
				spec: { keyframes: [{ percentage: 100, x: 40 }] },
			},
		});

		expect(params).toMatchObject({
			label: "Explode letters",
			kind: "animation",
			intent: "Explode each letter outward.",
		});
		expect(params.specJson).toContain("effect-layer");
		expect(params.specJson).toContain("keyframes");
	});

	test("builds visible effect layer elements for custom edit operations", () => {
		const element = buildCustomEditEffectElement({
			operation: {
				type: "attach_custom_edit",
				trackId: "text",
				elementId: "inside",
				label: "Blur zoom",
				startTime: t(120),
				duration: t(60),
				spec: { effect: "blur zoom" },
			},
			target: {
				startTime: t(100),
				duration: t(100),
			},
		});

		expect(element).toMatchObject({
			type: "effect",
			name: "AI: Blur zoom",
			effectType: CUSTOM_AI_EFFECT_TYPE,
			startTime: t(120),
			duration: t(60),
		});
	});

	test("applies clip effects through the native element effect stack", () => {
		const calls: Array<{ type: string; params: unknown }> = [];
		const editor = {
			scenes: { getActiveSceneOrNull: () => ({ tracks }) },
			timeline: {
				addClipEffect: (params: unknown) => calls.push({ type: "add", params }),
				updateClipEffectParams: (params: unknown) =>
					calls.push({ type: "update", params }),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Native effects",
				summary: "",
				operations: [
					{
						type: "add_clip_effect",
						trackId: "text",
						elementId: "inside",
						effectType: "blur",
						params: { intensity: 42 },
					},
					{
						type: "update_clip_effect_params",
						trackId: "text",
						elementId: "inside",
						effectId: "effect-blur",
						params: { intensity: 55 },
					},
				],
			},
		});

		expect(calls).toEqual([
			{
				type: "add",
				params: {
					trackId: "text",
					elementId: "inside",
					effectType: "blur",
					params: { intensity: 42 },
				},
			},
			{
				type: "update",
				params: {
					trackId: "text",
					elementId: "inside",
					effectId: "effect-blur",
					params: { intensity: 55 },
				},
			},
		]);
	});

	test("rolls back earlier operations when applying a later operation fails", () => {
		const calls: string[] = [];
		const editor = {
			scenes: {
				getActiveSceneOrNull: () => ({ tracks }),
			},
			timeline: {
				insertElement: () => calls.push("insert"),
				moveElements: () => {
					calls.push("move");
					throw new Error("Target track not found");
				},
				updateTracks: (nextTracks: SceneTracks) => {
					expect(nextTracks).toBe(tracks);
					calls.push("rollback");
				},
			},
		} as unknown as EditorCore;

		expect(() =>
			applyAiEditPlan({
				editor,
				plan: {
					title: "Partial failure",
					summary: "",
					operations: [
						{
							type: "insert_text_element",
							content: "First",
							startTime: t(0),
							duration: t(10),
						},
						{
							type: "move_element",
							sourceTrackId: "text",
							targetTrackId: "missing",
							elementId: "inside",
							startTime: t(100),
						},
					],
				},
			}),
		).toThrow("Target track not found");

		expect(calls).toEqual(["insert", "move", "rollback"]);
	});

	test("applies a multi-operation plan through one command transaction", () => {
		let transactionCount = 0;
		const calls: string[] = [];
		const editor = {
			command: {
				executeTransaction: <T>({ execute }: { execute: () => T }): T => {
					transactionCount += 1;
					return execute();
				},
			},
			scenes: { getActiveSceneOrNull: () => ({ tracks }) },
			timeline: {
				getTrackById: ({ trackId }: { trackId: string }) =>
					trackId === "audio-track" ? tracks.audio[0] : tracks.overlay[0],
				toggleTrackMute: () => calls.push("mute"),
				toggleTrackVisibility: () => calls.push("visibility"),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Track changes",
				summary: "",
				operations: [
					{
						type: "set_track_state",
						trackId: "audio-track",
						muted: true,
					},
					{
						type: "set_track_state",
						trackId: "text",
						hidden: true,
					},
				],
			},
		});

		expect(transactionCount).toBe(1);
		expect(calls).toEqual(["mute", "visibility"]);
	});

	test("applies scene, project-setting, and bookmark changes atomically", () => {
		let scenes: TScene[] = [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks,
				bookmarks: [],
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
		];
		let activeSceneId = "scene-main";
		let project: TProject = {
			metadata: {
				id: "project-1",
				name: "Project",
				duration: t(0),
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			scenes,
			currentSceneId: activeSceneId,
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color" as const, color: "#000000" },
			},
			version: 1,
		};
		let dirtyCount = 0;
		let transactionCount = 0;
		const editor = {
			command: {
				executeTransaction: <T>({ execute }: { execute: () => T }): T => {
					transactionCount += 1;
					return execute();
				},
			},
			scenes: {
				getScenes: () => scenes,
				getActiveSceneOrNull: () =>
					scenes.find((scene) => scene.id === activeSceneId) ?? null,
				setScenes: ({
					scenes: nextScenes,
					activeSceneId: nextActiveSceneId,
				}: {
					scenes: TScene[];
					activeSceneId?: string;
				}) => {
					scenes = nextScenes;
					activeSceneId = nextActiveSceneId ?? activeSceneId;
					project = { ...project, scenes };
				},
			},
			project: {
				getActive: () => project,
				setActiveProject: ({ project: next }: { project: TProject }) => {
					project = next;
				},
			},
			save: {
				markDirty: () => {
					dirtyCount += 1;
				},
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Project organization",
				summary: "",
				operations: [
					{
						type: "rename_scene",
						sceneId: "scene-main",
						name: "Primary cut",
					},
					{
						type: "set_project_settings",
						canvasSize: { width: 1080, height: 1920 },
					},
					{
						type: "add_bookmark",
						time: t(120_000),
						note: "Opening beat",
					},
				],
			},
		});

		expect(transactionCount).toBe(1);
		expect(scenes[0].name).toBe("Primary cut");
		expect(scenes[0].bookmarks).toEqual([
			{ time: t(120_000), note: "Opening beat" },
		]);
		expect(project.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(project.settings.canvasSizeMode).toBe("custom");
		expect(dirtyCount).toBe(3);
	});

	test("applies full Timeline Source state and provenance in one transaction", () => {
		const fixture = buildFullSourceEditForTest({
			mutate: (document) => {
				document.scene.name = "Source-controlled cut";
				document.projectSettings.canvasSize = { width: 1080, height: 1920 };
				getSourceElementForTest({ document, elementId: "inside" }).params.text =
					"source-controlled title";
			},
		});
		let project: TProject = {
			metadata: {
				id: "project-full-source",
				name: "Project",
				duration: t(600),
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			scenes: [fixture.scene],
			currentSceneId: fixture.scene.id,
			settings: fixture.projectSettings,
			aiEditHistory: [],
			version: 1,
		};
		let transactionCount = 0;
		/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- focused editor adapter fixture. */
		const editor = {
			command: {
				executeTransaction: <T>({ execute }: { execute: () => T }): T => {
					transactionCount += 1;
					return execute();
				},
			},
			scenes: {
				getScenes: () => project.scenes,
				getActiveSceneOrNull: () =>
					project.scenes.find((scene) => scene.id === project.currentSceneId) ??
					null,
				setScenes: ({ scenes }: { scenes: TScene[] }) => {
					project = { ...project, scenes };
				},
			},
			project: {
				getActive: () => project,
				getActiveOrNull: () => project,
				setActiveProject: ({ project: next }: { project: TProject }) => {
					project = next;
				},
			},
			save: { markDirty: () => undefined },
		} as unknown as EditorCore;
		/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

		applyAiEditPlan({
			editor,
			timelineSourceV2ScopeValidator: validateTimelineSourceV2ScopeForTest,
			plan: {
				title: "Apply full source",
				summary: "Replace persistent active-scene state",
				operations: [
					{
						type: "apply_timeline_source_v2",
						baseRevision: fixture.current.baseRevision,
						document: fixture.document,
						reason: "Apply exact reviewed source",
					},
				],
			},
		});

		expect(transactionCount).toBe(1);
		expect(project.scenes[0]?.name).toBe("Source-controlled cut");
		expect(
			project.scenes[0]?.tracks.overlay[0]?.elements[0]?.params,
		).toMatchObject({
			text: "source-controlled title",
		});
		expect(project.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(project.aiEditHistory).toHaveLength(1);
		expect(project.aiEditHistory?.[0]?.layers[0]).toMatchObject({
			operationType: "apply_timeline_source_v2",
			anchor: { kind: "project" },
		});
	});

	test("starts a reviewed export task without returning its buffer", () => {
		let startedOptions: Record<string, unknown> | null = null;
		let transactionCount = 0;
		const editor = {
			command: {
				executeTransaction: () => {
					transactionCount += 1;
				},
			},
			project: {
				getExportState: () => ({
					isExporting: false,
					progress: 0,
					result: null,
				}),
				getActive: () => ({
					settings: { fps: { numerator: 30, denominator: 1 } },
				}),
				export: async ({ options }: { options: Record<string, unknown> }) => {
					startedOptions = options;
					return { success: true, buffer: new ArrayBuffer(0) };
				},
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Export",
				summary: "",
				operations: [
					{
						type: "start_export_task",
						format: "webm",
						quality: "very_high",
						includeAudio: false,
					},
				],
			},
		});

		expect(transactionCount).toBe(0);
		expect(startedOptions).toEqual({
			format: "webm",
			quality: "very_high",
			fps: { numerator: 30, denominator: 1 },
			includeAudio: false,
		});
	});

	test("starts a reviewed transcription task outside the command transaction", () => {
		let startedOptions: Record<string, unknown> | null = null;
		let transactionCount = 0;
		const editor = {
			command: {
				executeTransaction: () => {
					transactionCount += 1;
				},
			},
			transcription: {
				getState: () => ({
					task: {
						taskId: undefined,
						kind: undefined,
						status: "idle",
						progressBasisPoints: 0,
						phase: undefined,
						error: undefined,
					},
					insertedTrackIds: [],
				}),
				start: async (options: Record<string, unknown>) => {
					startedOptions = options;
					return {};
				},
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Generate captions",
				summary: "",
				operations: [{ type: "start_transcription_task", language: "en" }],
			},
		});

		expect(transactionCount).toBe(0);
		expect(startedOptions).toEqual({ language: "en" });
	});
});

describe("AI expanded operations", () => {
	const mediaAssets = [
		{
			id: "media-clip",
			name: "clip.mp4",
			type: "video" as const,
			duration: 10,
			file: new File([], "clip.mp4"),
		},
	];

	test("accepts track operations targeting existing tracks", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Track ops",
				summary: "",
				operations: [
					{ type: "add_track", trackType: "text" },
					{ type: "reorder_track", trackId: "text", toIndex: 0 },
					{ type: "set_track_state", trackId: "audio-track", muted: true },
				],
			},
			tracks,
		});

		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	});

	test("rejects track operations on missing tracks", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Bad track op",
				summary: "",
				operations: [{ type: "remove_track", trackId: "missing-track" }],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("missing track");
	});

	test("accepts insert_media_element with a known asset", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Insert clip",
				summary: "",
				operations: [
					{
						type: "insert_media_element",
						mediaId: "media-clip",
						startTime: t(0),
					},
				],
			},
			tracks,
			mediaAssets,
		});

		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	});

	test("rejects insert_media_element with an unknown asset", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Insert missing clip",
				summary: "",
				operations: [
					{
						type: "insert_media_element",
						mediaId: "not-a-media-id",
						startTime: t(0),
					},
				],
			},
			tracks,
			mediaAssets,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("missing media asset");
	});

	test("accepts shared-library audio on an audio track and enforces range bounds", () => {
		const valid = validateAiEditPlan({
			value: {
				title: "Add impact",
				summary: "",
				operations: [
					{
						type: "insert_library_audio_element",
						libraryAssetId: "audio-1",
						name: "Whoosh impact",
						startTime: t(250),
						duration: t(100),
						trackId: "audio-track",
					},
				],
			},
			tracks,
			range: { startTime: t(200), endTime: t(400) },
		});
		const outsideRange = validateAiEditPlan({
			value: {
				title: "Add late impact",
				summary: "",
				operations: [
					{
						type: "insert_library_audio_element",
						libraryAssetId: "audio-1",
						name: "Whoosh impact",
						startTime: t(350),
						duration: t(100),
					},
				],
			},
			tracks,
			range: { startTime: t(200), endTime: t(400) },
		});

		expect(valid).toMatchObject({ success: true, errors: [] });
		expect(outsideRange.success).toBe(false);
		expect(outsideRange.errors).toContain(
			"insert_library_audio_element is outside the selected range",
		);
	});

	test("rejects shared-library audio on an incompatible video track", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Misplaced audio",
				summary: "",
				operations: [
					{
						type: "insert_library_audio_element",
						libraryAssetId: "audio-1",
						name: "Whoosh impact",
						startTime: t(250),
						duration: t(100),
						trackId: "main",
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors.join("\n")).toContain(
			"audio elements cannot be placed on video tracks",
		);
	});

	test("inserts persisted shared-library audio without reading the file", () => {
		const inserted: Array<{ element: unknown; placement: unknown }> = [];
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- focused adapter exposes only the insertion dependencies exercised here.
		const editor = {
			scenes: { getActiveSceneOrNull: () => ({ tracks }) },
			timeline: {
				insertElement: (params: { element: unknown; placement: unknown }) =>
					inserted.push(params),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Add impact",
				summary: "",
				operations: [
					{
						type: "insert_library_audio_element",
						libraryAssetId: "audio-1",
						name: "Whoosh impact",
						startTime: t(240_000),
						duration: t(150_000),
					},
				],
			},
		});

		expect(inserted).toEqual([
			{
				element: expect.objectContaining({
					type: "audio",
					sourceType: "library",
					librarySourceType: "shared",
					libraryAssetId: "audio-1",
					name: "Whoosh impact",
					startTime: t(240_000),
					duration: t(150_000),
				}),
				placement: { mode: "auto", trackType: "audio" },
			},
		]);
		expect(inserted[0]?.element).not.toHaveProperty("buffer");
		expect(inserted[0]?.element).not.toHaveProperty("sourceUrl");
	});

	test("accepts insert_graphic_element with a known definition", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Insert shape",
				summary: "",
				operations: [
					{
						type: "insert_graphic_element",
						definitionId: "rectangle",
						startTime: t(0),
						duration: t(100),
					},
				],
			},
			tracks,
		});

		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	});

	test("rejects a graphic insertion explicitly targeting the main video track", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Insert shape on main",
				summary: "",
				operations: [
					{
						type: "insert_graphic_element",
						definitionId: "rectangle",
						trackId: "main",
						startTime: t(0),
						duration: t(100),
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors).toContain(
			"graphic elements cannot be placed on video tracks",
		);
	});

	test("rejects insert_graphic_element with an unknown definition", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Insert bad shape",
				summary: "",
				operations: [
					{
						type: "insert_graphic_element",
						definitionId: "not-a-shape",
						startTime: t(0),
						duration: t(100),
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("unknown graphic definition");
	});

	test("accepts insert_html_element and enforces the active range", () => {
		const accepted = validateAiEditPlan({
			value: {
				title: "Insert HTML frame",
				summary: "",
				operations: [
					{
						type: "insert_html_element",
						html: "<div>Hello</div>",
						startTime: t(100),
						duration: t(100),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});
		expect(accepted.errors).toEqual([]);
		expect(accepted.success).toBe(true);

		const rejected = validateAiEditPlan({
			value: {
				title: "Insert HTML frame late",
				summary: "",
				operations: [
					{
						type: "insert_html_element",
						html: "<div>Hello</div>",
						startTime: t(200),
						duration: t(100),
					},
				],
			},
			tracks,
			range: { startTime: t(90), endTime: t(220) },
		});
		expect(rejected.success).toBe(false);
		expect(rejected.errors[0]).toContain("outside the selected range");
	});

	test("rejects apply_transition with an unknown preset", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Bad transition",
				summary: "",
				operations: [
					{
						type: "apply_transition",
						trackId: "text",
						elementId: "inside",
						presetId: "not-a-preset",
						side: "in",
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("unknown transition preset");
	});

	test("accepts apply_transition with a known preset on a visual element", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Fade in",
				summary: "",
				operations: [
					{
						type: "apply_transition",
						trackId: "text",
						elementId: "inside",
						presetId: "fade",
						side: "in",
					},
				],
			},
			tracks,
		});

		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	});

	test("rejects retime_element on non-retimable elements", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Speed up text",
				summary: "",
				operations: [
					{
						type: "retime_element",
						trackId: "text",
						elementId: "inside",
						rate: 2,
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("not a video or audio element");
	});

	test("accepts retime_element on audio elements", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Speed up audio",
				summary: "",
				operations: [
					{
						type: "retime_element",
						trackId: "audio-track",
						elementId: "audio",
						rate: 1.5,
					},
				],
			},
			tracks,
		});

		expect(result.errors).toEqual([]);
		expect(result.success).toBe(true);
	});

	test("rejects hiding elements that cannot be hidden", () => {
		const result = validateAiEditPlan({
			value: {
				title: "Hide audio",
				summary: "",
				operations: [
					{
						type: "set_element_state",
						trackId: "audio-track",
						elementId: "audio",
						hidden: true,
					},
				],
			},
			tracks,
		});

		expect(result.success).toBe(false);
		expect(result.errors[0]).toContain("not a visual element");
	});

	test("derives a compatible track when applying a graphic insertion", () => {
		const inserted: Array<{ element: unknown; placement: unknown }> = [];
		const editor = {
			scenes: {
				getActiveSceneOrNull: () => ({ tracks }),
			},
			timeline: {
				insertElement: (params: { element: unknown; placement: unknown }) =>
					inserted.push(params),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Insert shape",
				summary: "",
				operations: [
					{
						type: "insert_graphic_element",
						definitionId: "rectangle",
						startTime: t(0),
						duration: t(120_000),
					},
				],
			},
		});

		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.element).toMatchObject({
			type: "graphic",
			definitionId: "rectangle",
		});
		expect(inserted[0]?.placement).toEqual({ mode: "auto" });
	});

	test("applies insert_html_element as a hyperframe graphic", () => {
		const inserted: Array<{ element: unknown; placement: unknown }> = [];
		const editor = {
			scenes: {
				getActiveSceneOrNull: () => ({ tracks }),
			},
			timeline: {
				insertElement: (params: { element: unknown; placement: unknown }) =>
					inserted.push(params),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Insert HTML frame",
				summary: "",
				operations: [
					{
						type: "insert_html_element",
						name: "Kinetic title",
						html: "<div>Hello</div>",
						startTime: t(0),
						duration: t(240_000),
					},
				],
			},
		});

		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.element).toMatchObject({
			type: "graphic",
			definitionId: "hyperframe",
			name: "Kinetic title",
			duration: t(240_000),
			params: {
				html: "<div>Hello</div>",
				sourceWidth: 1920,
				sourceHeight: 1080,
			},
		});
		expect(inserted[0]?.placement).toEqual({
			mode: "auto",
		});
	});

	test("auto-places inserted stickers and effect layers on compatible tracks", () => {
		const inserted: Array<{ element: unknown; placement: unknown }> = [];
		const validation = validateAiEditPlan({
			value: {
				title: "Creative overlays",
				summary: "",
				operations: [
					{
						type: "insert_sticker_element",
						stickerId: "builtin:star",
						startTime: t(0),
						duration: t(120_000),
					},
					{
						type: "insert_effect_element",
						effectType: "blur",
						startTime: t(0),
						duration: t(120_000),
					},
				],
			},
			tracks,
		});
		expect(validation.success).toBe(true);
		if (!validation.plan) throw new Error("Expected a valid insertion plan");
		const editor = {
			scenes: { getActiveSceneOrNull: () => ({ tracks }) },
			timeline: {
				insertElement: (params: { element: unknown; placement: unknown }) =>
					inserted.push(params),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({ editor, plan: validation.plan });

		expect(inserted).toMatchObject([
			{
				element: { type: "sticker", stickerId: "builtin:star" },
				placement: { mode: "auto", trackType: "graphic" },
			},
			{
				element: { type: "effect", effectType: "blur" },
				placement: { mode: "auto", trackType: "effect" },
			},
		]);
	});

	test("applies set_track_state through mute/visibility toggles", () => {
		const calls: string[] = [];
		const editor = {
			scenes: {
				getActiveSceneOrNull: () => ({ tracks }),
			},
			timeline: {
				getTrackById: ({ trackId }: { trackId: string }) =>
					trackId === "audio-track" ? tracks.audio[0] : null,
				toggleTrackMute: () => calls.push("mute"),
				toggleTrackVisibility: () => calls.push("visibility"),
			},
		} as unknown as EditorCore;

		applyAiEditPlan({
			editor,
			plan: {
				title: "Mute audio track",
				summary: "",
				operations: [
					{
						type: "set_track_state",
						trackId: "audio-track",
						muted: true,
					},
				],
			},
		});

		expect(calls).toEqual(["mute"]);
	});
});
