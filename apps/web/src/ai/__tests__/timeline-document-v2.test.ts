import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TProjectSettings } from "@/project/types";
import type { AudioTrack, TScene } from "@/timeline/types";
import type { TimelineDocumentV2Canonicalizer } from "../timeline-document-v2";

interface MutableTimelineDocument {
	schemaVersion: number;
	projectSettings: {
		fps: { denominator: number };
	};
	scene: {
		bookmarks: Array<{ time: number }>;
		tracks: Array<{
			id: string;
			area: string;
			elements: Array<Record<string, unknown>>;
		}>;
	};
}

const canonicalizerInputs: string[] = [];

mock.module("../timeline-document-v2-canonicalizer", () => ({
	defaultTimelineDocumentV2Canonicalizer: undefined,
}));

let buildTimelineDocumentV2WithWasm: typeof import("../timeline-document-v2").buildTimelineDocumentV2;
let parseTimelineDocumentV2WithWasm: typeof import("../timeline-document-v2").parseTimelineDocumentV2;

const canonicalizeForTest: TimelineDocumentV2Canonicalizer = ({ json }) => {
	canonicalizerInputs.push(json);
	let value: unknown;
	try {
		value = JSON.parse(json);
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

	const canonical = sortJson(value);
	const compact = JSON.stringify(canonical);
	const diagnostics = validateRustEnvelope(canonical);
	return {
		valid: diagnostics.length === 0,
		formattedJson: `${JSON.stringify(canonical, null, 2)}\n`,
		baseRevision: `mock-sha256:${stableHash(compact)}`,
		diagnostics,
	};
};

beforeAll(async () => {
	({ buildTimelineDocumentV2: buildTimelineDocumentV2WithWasm } =
		await import("../timeline-document-v2"));
	({ parseTimelineDocumentV2: parseTimelineDocumentV2WithWasm } =
		await import("../timeline-document-v2"));
});

function buildTimelineDocumentV2(
	options: Omit<
		Parameters<typeof buildTimelineDocumentV2WithWasm>[0],
		"canonicalize"
	>,
) {
	return buildTimelineDocumentV2WithWasm({
		...options,
		canonicalize: canonicalizeForTest,
	});
}

function parseTimelineDocumentV2(
	options: Omit<
		Parameters<typeof parseTimelineDocumentV2WithWasm>[0],
		"canonicalize"
	>,
) {
	return parseTimelineDocumentV2WithWasm({
		...options,
		canonicalize: canonicalizeForTest,
	});
}

beforeEach(() => {
	canonicalizerInputs.length = 0;
});

describe("Timeline Source v2 web adapter", () => {
	test("builds an ordered full-fidelity document and strips only AudioBuffer", () => {
		const { project, scene } = createRichFixture();

		const result = buildTimelineDocumentV2({ project, scene });

		expect(result.valid).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(result.baseRevision).toStartWith("mock-sha256:");
		expect(result.formattedText.endsWith("\n")).toBe(true);
		expect(canonicalizerInputs).toHaveLength(1);

		const document = JSON.parse(result.formattedText);
		expect(document.schemaVersion).toBe(2);
		expect(document.projectSettings).toEqual(project.settings);
		expect(document.scene).toMatchObject({
			id: "scene-1",
			name: "Launch film",
			isMain: true,
			createdAt: "2026-07-01T10:00:00.000Z",
			updatedAt: "2026-07-02T11:30:00.000Z",
		});
		expect(
			document.scene.tracks.map((track: { id: string; area: string }) => [
				track.id,
				track.area,
			]),
		).toEqual([
			["graphic-track", "overlay"],
			["main-track", "main"],
			["audio-track", "audio"],
			["text-track", "overlay"],
			["effect-track", "overlay"],
		]);

		const sourceGraphicTrack = scene.tracks.overlay[1];
		if (sourceGraphicTrack.type !== "graphic") {
			throw new Error("fixture must contain a graphic track");
		}
		const sourceGraphic = sourceGraphicTrack.elements[0];
		if (sourceGraphic.type !== "graphic") {
			throw new Error("fixture must contain a graphic element");
		}
		const graphic = document.scene.tracks[0].elements[0];
		expect(graphic.effects).toEqual(sourceGraphic.effects);
		expect(graphic.masks).toEqual(sourceGraphic.masks);
		expect(graphic.animations).toEqual(sourceGraphic.animations);
		expect(graphic.transitions).toEqual(sourceGraphic.transitions);

		const sourceMainVideo = scene.tracks.main.elements[0];
		if (sourceMainVideo.type !== "video") {
			throw new Error("fixture must contain a video element");
		}
		const mainVideo = document.scene.tracks[1].elements[0];
		expect(mainVideo.backgroundRemoval).toEqual(
			sourceMainVideo.backgroundRemoval,
		);
		expect(mainVideo.retime).toEqual({ rate: 1.25, maintainPitch: true });

		const audio = document.scene.tracks[2].elements[0];
		expect(audio).not.toHaveProperty("buffer");
		expect(audio).toMatchObject({
			sourceType: "library",
			sourceUrl: "https://cdn.example/music.mp3",
			libraryAssetId: "music-7",
			librarySourceType: "shared",
		});

		const sourceTextTrack = scene.tracks.overlay[0];
		if (sourceTextTrack.type !== "text") {
			throw new Error("fixture must contain a text track");
		}
		const sourceText = sourceTextTrack.elements[0];
		const textTrack = document.scene.tracks[3];
		expect(textTrack.captionSource).toEqual(sourceTextTrack.captionSource);
		expect(textTrack.elements[0].wordRuns).toEqual(sourceText.wordRuns);
		expect(textTrack.elements[0].textRowOverrides).toEqual(
			sourceText.textRowOverrides,
		);
	});

	test("round-trips application-ready tracks, bookmarks, settings, and dates", () => {
		const { project, scene } = createRichFixture();
		const built = buildTimelineDocumentV2({ project, scene });

		const parsed = parseTimelineDocumentV2({ text: built.formattedText });

		expect(parsed.valid).toBe(true);
		expect(parsed.value).not.toBeNull();
		expect(parsed.value?.projectSettings).toEqual(project.settings);
		expect(parsed.value?.bookmarks).toEqual(scene.bookmarks);
		expect(parsed.value?.scene).toEqual({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			createdAt: scene.createdAt,
			updatedAt: scene.updatedAt,
		});
		expect(parsed.value?.tracks.order).toEqual([
			"graphic-track",
			"main-track",
			"audio-track",
			"text-track",
			"effect-track",
		]);
		expect(parsed.value?.tracks.main).toEqual(scene.tracks.main);
		expect(parsed.value?.tracks.overlay.map((track) => track.id)).toEqual([
			"graphic-track",
			"text-track",
			"effect-track",
		]);
		expect(parsed.value?.tracks.overlay[0]).toEqual(scene.tracks.overlay[1]);
		expect(parsed.value?.tracks.overlay[1]).toEqual(scene.tracks.overlay[0]);
		expect(parsed.value?.tracks.audio[0]).toEqual(
			stripAudioBuffers(scene.tracks.audio[0]),
		);
	});

	test("rejects element-to-track and track-to-area incompatibilities", () => {
		const document = createBuiltDocument();
		document.scene.tracks[1].elements[0] = {
			...document.scene.tracks[1].elements[0],
			type: "graphic",
			definitionId: "lower-third",
		};
		document.scene.tracks[0].area = "audio";

		const result = parseTimelineDocumentV2({
			text: JSON.stringify(document),
		});

		expect(result.valid).toBe(false);
		expect(result.value).toBeNull();
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"incompatible_element_type",
		);
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"incompatible_track_area",
		);
	});

	test("rejects duplicate ids without exposing a partial scene", () => {
		const document = createBuiltDocument();
		document.scene.tracks[3].id = document.scene.tracks[0].id;
		document.scene.tracks[3].elements[0].id =
			document.scene.tracks[1].elements[0].id;

		const result = parseTimelineDocumentV2({
			text: JSON.stringify(document),
		});

		expect(result.valid).toBe(false);
		expect(result.value).toBeNull();
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"duplicate_track_id",
		);
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"duplicate_element_id",
		);
	});

	test("rejects malformed settings, bookmarks, timing, and runtime source fields", () => {
		const document = createBuiltDocument();
		document.projectSettings.fps.denominator = 0;
		document.scene.bookmarks[0].time = 1.5;
		document.scene.tracks[1].elements[0].duration = "forever";
		document.scene.tracks[2].elements[0].buffer = { runtime: true };

		const result = parseTimelineDocumentV2({
			text: JSON.stringify(document),
		});

		expect(result.valid).toBe(false);
		expect(result.value).toBeNull();
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"invalid_type",
		);
		expect(result.diagnostics.map(({ code }) => code)).toContain(
			"runtime_field_not_allowed",
		);
	});

	test("passes through Rust invalid JSON and schema diagnostics", () => {
		const invalidJson = parseTimelineDocumentV2({ text: "{ nope" });
		expect(invalidJson).toMatchObject({
			valid: false,
			formattedText: "",
			baseRevision: "",
			value: null,
		});
		expect(invalidJson.diagnostics[0].code).toBe("invalid_json");

		const document = createBuiltDocument();
		document.schemaVersion = 1;
		const wrongSchema = parseTimelineDocumentV2({
			text: JSON.stringify(document),
		});
		expect(wrongSchema.valid).toBe(false);
		expect(wrongSchema.value).toBeNull();
		expect(wrongSchema.diagnostics.map(({ code }) => code)).toContain(
			"unsupported_schema_version",
		);
	});

	test("fails safely when a persistent field contains a non-JSON runtime value", () => {
		const { project, scene } = createRichFixture();
		const element = scene.tracks.overlay[1].elements[0];
		if (!("effects" in element) || !element.effects?.[0]) {
			throw new Error("fixture must contain an effect");
		}
		Object.defineProperty(element.effects[0].params, "runtimeCallback", {
			value: () => undefined,
			enumerable: true,
		});

		const result = buildTimelineDocumentV2({ project, scene });

		expect(result.valid).toBe(false);
		expect(result.formattedText).toBe("");
		expect(result.diagnostics[0]).toMatchObject({
			code: "non_json_runtime_value",
		});
		expect(canonicalizerInputs).toHaveLength(0);
	});
});

function createBuiltDocument(): MutableTimelineDocument {
	const { project, scene } = createRichFixture();
	const result = buildTimelineDocumentV2({ project, scene });
	expect(result.valid).toBe(true);
	const document: unknown = JSON.parse(result.formattedText);
	if (!isMutableTimelineDocument(document)) {
		throw new Error("fixture builder returned an unexpected document shape");
	}
	return document;
}

function createRichFixture(): {
	project: { settings: TProjectSettings };
	scene: TScene;
} {
	const settings = {
		fps: { numerator: 30_000, denominator: 1_001 },
		canvasSize: { width: 1_920, height: 1_080 },
		canvasSizeMode: "custom",
		lastCustomCanvasSize: { width: 1_280, height: 720 },
		originalCanvasSize: { width: 3_840, height: 2_160 },
		background: { type: "color", color: "#10131aff" },
	} satisfies TProjectSettings;

	const baseElement = {
		duration: 240_000,
		startTime: 0,
		trimStart: 12_000,
		trimEnd: 252_000,
		sourceDuration: 480_000,
		params: {
			opacity: 0.85,
			blendMode: "screen",
			enabled: true,
		},
	};
	const scene = {
		id: "scene-1",
		name: "Launch film",
		isMain: true,
		createdAt: new Date("2026-07-01T10:00:00.000Z"),
		updatedAt: new Date("2026-07-02T11:30:00.000Z"),
		bookmarks: [
			{ time: 120_000, duration: 60_000, note: "Hook", color: "#ff00aa" },
		],
		tracks: {
			overlay: [
				{
					id: "text-track",
					name: "Captions",
					type: "text",
					hidden: false,
					captionSource: {
						sourceId: "transcription-1",
						words: [
							{
								id: "word-source-1",
								text: "Launch",
								startTime: 0,
								endTime: 60_000,
							},
						],
						settings: {
							maxWordsPerLine: 4,
							maxLines: 2,
							gapThreshold: 30_000,
						},
						layerIndex: 0,
						layerCount: 1,
					},
					elements: [
						{
							...baseElement,
							id: "text-1",
							name: "Launch caption",
							type: "text",
							captionRevealMode: "spoken-word-keep",
							captionTransitionIn: "blur-zoom",
							captionAccentColor: "#ffee00",
							captionWordDirection: "ltr",
							captionGlowerEnabled: true,
							captionLightningStormEnabled: true,
							captionGlitchyEnabled: false,
							clipMediaId: "clip-1",
							wordRuns: [
								{
									id: "word-run-1",
									text: "Launch",
									lineIndex: 0,
									startTime: 0,
									endTime: 60_000,
									style: { scale: 1.25, color: "#ffee00" },
								},
							],
							textRowOverrides: [
								{
									id: "row-1",
									lineIndex: 0,
									transitionIn: "rise",
								},
							],
							effects: [
								{
									id: "text-effect-1",
									type: "shadow",
									enabled: true,
									params: { blur: 12, color: "#000000" },
								},
							],
						},
					],
				},
				{
					id: "graphic-track",
					name: "Graphics",
					type: "graphic",
					hidden: false,
					elements: [
						{
							...baseElement,
							id: "graphic-1",
							name: "Hero lower third",
							type: "graphic",
							definitionId: "hyperframe",
							effects: [
								{
									id: "effect-1",
									type: "chromatic-aberration",
									enabled: true,
									params: { amount: 0.6, direction: "radial" },
								},
							],
							masks: [
								{
									id: "mask-1",
									type: "freeform",
									params: {
										feather: 8,
										inverted: false,
										strokeColor: "#ffffff",
										strokeWidth: 1,
										strokeAlign: "center",
										path: [
											{ x: 0.1, y: 0.2 },
											{ x: 0.8, y: 0.7 },
										],
										closed: true,
										centerX: 0.5,
										centerY: 0.5,
										rotation: 4,
										scale: 1,
									},
								},
							],
							animations: {
								"transform.positionX": {
									keys: [
										{
											id: "keyframe-1",
											time: 24_000,
											value: 100,
											leftHandle: { dt: -4_000, dv: -10 },
											rightHandle: { dt: 4_000, dv: 10 },
											segmentToNext: "bezier",
											tangentMode: "broken",
										},
									],
									extrapolation: { before: "hold", after: "linear" },
								},
							},
							transitions: {
								in: {
									id: "transition-1",
									presetId: "fade",
									placement: "in",
									duration: 18_000,
									startTime: 0,
									createdAt: "2026-07-01T10:00:00.000Z",
								},
							},
						},
						{
							...baseElement,
							id: "sticker-1",
							name: "Spark",
							type: "sticker",
							stickerId: "spark-asset",
							intrinsicWidth: 512,
							intrinsicHeight: 384,
						},
					],
				},
				{
					id: "effect-track",
					name: "Global grade",
					type: "effect",
					hidden: false,
					elements: [
						{
							...baseElement,
							id: "effect-element-1",
							name: "Film grade",
							type: "effect",
							effectType: "film-grain",
						},
					],
				},
			],
			main: {
				id: "main-track",
				name: "Main video",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					{
						...baseElement,
						id: "video-1",
						name: "Launch clip",
						type: "video",
						mediaId: "media-video-1",
						isSourceAudioEnabled: true,
						hidden: false,
						retime: { rate: 1.25, maintainPitch: true },
						backgroundRemoval: {
							enabled: true,
							mode: "replace",
							quality: "quality",
							maskThreshold: 0.45,
							edgeContrast: 1.2,
							edgeFeather: 3,
							temporalSmoothing: 0.7,
							blurStrength: 4,
						},
					},
					{
						...baseElement,
						id: "image-1",
						name: "Logo",
						type: "image",
						mediaId: "media-image-1",
					},
				],
			},
			audio: [
				{
					id: "audio-track",
					name: "Music",
					type: "audio",
					muted: false,
					elements: [
						{
							...baseElement,
							id: "audio-1",
							name: "Score",
							type: "audio",
							sourceType: "library",
							sourceUrl: "https://cdn.example/music.mp3",
							libraryAssetId: "music-7",
							librarySourceType: "shared",
							retime: { rate: 0.95, maintainPitch: true },
							buffer: { runtimeAudioBuffer: true },
						},
					],
				},
			],
			order: [
				"graphic-track",
				"main-track",
				"audio-track",
				"text-track",
				"effect-track",
			],
		},
	} as unknown as TScene;

	return { project: { settings }, scene };
}

function stripAudioBuffers(value: AudioTrack): AudioTrack {
	const cloned = structuredClone(value);
	for (const element of cloned.elements) delete element.buffer;
	return cloned;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortJson(value[key])]),
	);
}

function validateRustEnvelope(value: unknown): Array<{
	code: string;
	path: string;
	message: string;
}> {
	const diagnostics: Array<{ code: string; path: string; message: string }> =
		[];
	if (!isRecord(value)) {
		return [
			{
				code: "invalid_shape",
				path: "$",
				message: "document must be an object",
			},
		];
	}
	if (value.schemaVersion !== 2) {
		diagnostics.push({
			code: "unsupported_schema_version",
			path: "$.schemaVersion",
			message: "schemaVersion must be the integer 2",
		});
	}
	if (!isRecord(value.scene)) {
		diagnostics.push({
			code: "missing_scene",
			path: "$.scene",
			message: "scene is required",
		});
		return diagnostics;
	}
	if (typeof value.scene.id !== "string" || value.scene.id.length === 0) {
		diagnostics.push({
			code: "missing_or_invalid_id",
			path: "$.scene.id",
			message: "scene.id must be a non-empty string",
		});
	}
	if (!Array.isArray(value.scene.tracks)) {
		diagnostics.push({
			code: "missing_tracks",
			path: "$.scene.tracks",
			message: "scene.tracks is required",
		});
		return diagnostics;
	}

	const trackIds = new Set<string>();
	const elementIds = new Set<string>();
	for (const [trackIndex, track] of value.scene.tracks.entries()) {
		if (!isRecord(track)) continue;
		if (typeof track.id === "string") {
			if (trackIds.has(track.id)) {
				diagnostics.push({
					code: "duplicate_track_id",
					path: `$.scene.tracks[${trackIndex}].id`,
					message: `Duplicate track id "${track.id}"`,
				});
			}
			trackIds.add(track.id);
		}
		if (!Array.isArray(track.elements)) continue;
		for (const [elementIndex, element] of track.elements.entries()) {
			if (!isRecord(element) || typeof element.id !== "string") continue;
			if (elementIds.has(element.id)) {
				diagnostics.push({
					code: "duplicate_element_id",
					path: `$.scene.tracks[${trackIndex}].elements[${elementIndex}].id`,
					message: `Duplicate element id "${element.id}"`,
				});
			}
			elementIds.add(element.id);
		}
	}
	return diagnostics;
}

function stableHash(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function isMutableTimelineDocument(
	value: unknown,
): value is MutableTimelineDocument {
	if (!isRecord(value) || typeof value.schemaVersion !== "number") return false;
	if (
		!isRecord(value.projectSettings) ||
		!isRecord(value.projectSettings.fps)
	) {
		return false;
	}
	if (typeof value.projectSettings.fps.denominator !== "number") return false;
	if (!isRecord(value.scene) || !Array.isArray(value.scene.bookmarks))
		return false;
	if (!Array.isArray(value.scene.tracks)) return false;
	return value.scene.tracks.every(
		(track) =>
			isRecord(track) &&
			typeof track.id === "string" &&
			typeof track.area === "string" &&
			Array.isArray(track.elements) &&
			track.elements.every(isRecord),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
