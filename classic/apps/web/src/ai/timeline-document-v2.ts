/* eslint-disable opencut/prefer-object-params -- Validation helpers are clearer as value/path/diagnostics tuples. */
import type { TProject, TProjectSettings } from "@/project/types";
import type {
	AudioTrack,
	Bookmark,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
	VideoTrack,
} from "@/timeline/types";
import { defaultTimelineDocumentV2Canonicalizer } from "./timeline-document-v2-canonicalizer";

export const TIMELINE_DOCUMENT_V2_SCHEMA_VERSION = 2 as const;

export interface TimelineDocumentV2Diagnostic {
	code: string;
	path: string;
	message: string;
}

export interface TimelineDocumentV2CanonicalResult {
	valid: boolean;
	formattedText: string;
	baseRevision: string;
	diagnostics: TimelineDocumentV2Diagnostic[];
}

export interface TimelineDocumentV2SceneMetadata {
	id: string;
	name: string;
	isMain: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface ParsedTimelineDocumentV2 {
	projectSettings: TProjectSettings;
	scene: TimelineDocumentV2SceneMetadata;
	tracks: SceneTracks;
	bookmarks: Bookmark[];
}

export interface ParseTimelineDocumentV2Result extends TimelineDocumentV2CanonicalResult {
	value: ParsedTimelineDocumentV2 | null;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type TrackArea = "overlay" | "main" | "audio";

export interface TimelineDocumentV2CanonicalizerResult {
	valid: boolean;
	formattedJson: string;
	baseRevision: string;
	diagnostics: TimelineDocumentV2Diagnostic[];
}

export type TimelineDocumentV2Canonicalizer = (options: {
	json: string;
}) => TimelineDocumentV2CanonicalizerResult;

interface OrderedTrackEntry {
	area: TrackArea;
	track: TimelineTrack;
}

class JsonSafetyError extends Error {
	constructor(
		readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "JsonSafetyError";
	}
}

/**
 * Build the full-fidelity Timeline Source v2 projection for one active scene.
 * The only timeline value intentionally omitted is AudioElement.buffer, which
 * is a runtime AudioBuffer cache and cannot be persisted as JSON.
 */
export function buildTimelineDocumentV2({
	project,
	scene,
	canonicalize,
}: {
	project: Pick<TProject, "settings">;
	scene: TScene;
	canonicalize?: TimelineDocumentV2Canonicalizer;
}): TimelineDocumentV2CanonicalResult {
	try {
		return canonicalizeJson({
			json: serializeTimelineDocumentV2ForCore({
				document: {
					projectSettings: project.settings,
					scene: {
						id: scene.id,
						name: scene.name,
						isMain: scene.isMain,
						createdAt: scene.createdAt,
						updatedAt: scene.updatedAt,
					},
					tracks: scene.tracks,
					bookmarks: scene.bookmarks,
				},
			}),
			canonicalize,
		});
	} catch (error) {
		if (error instanceof JsonSafetyError) {
			return invalidCanonicalResult({
				code: "non_json_runtime_value",
				path: error.path,
				message: error.message,
			});
		}
		throw error;
	}
}

/**
 * Project the web timeline shape into the shared Rust Timeline Source v2
 * envelope. This is serialization only; all cross-platform mutation policy is
 * enforced by the Rust core.
 */
export function serializeTimelineDocumentV2ForCore({
	document,
}: {
	document: ParsedTimelineDocumentV2;
}): string {
	const tracks = getOrderedTrackEntries(document.tracks).map(
		({ area, track }, trackIndex) =>
			serializeTrack({
				area,
				track,
				path: `$.scene.tracks[${trackIndex}]`,
			}),
	);
	const value: JsonObject = {
		schemaVersion: TIMELINE_DOCUMENT_V2_SCHEMA_VERSION,
		projectSettings: cloneJsonObject(
			document.projectSettings,
			"$.projectSettings",
		),
		scene: {
			id: document.scene.id,
			name: document.scene.name,
			isMain: document.scene.isMain,
			createdAt: serializeDate(document.scene.createdAt, "$.scene.createdAt"),
			updatedAt: serializeDate(document.scene.updatedAt, "$.scene.updatedAt"),
			bookmarks: cloneJsonArray(document.bookmarks, "$.scene.bookmarks"),
			tracks,
		},
	};
	return JSON.stringify(value);
}

/**
 * Canonicalize and strictly reconstruct an application-ready scene payload.
 * Any structural, type, id, track-area, or element compatibility problem
 * makes value null, so callers cannot accidentally apply a partial document.
 */
export function parseTimelineDocumentV2({
	text,
	canonicalize,
}: {
	text: string;
	canonicalize?: TimelineDocumentV2Canonicalizer;
}): ParseTimelineDocumentV2Result {
	const canonical = canonicalizeJson({ json: text, canonicalize });
	if (!canonical.formattedText) {
		return { ...canonical, value: null };
	}

	let document: unknown;
	try {
		document = JSON.parse(canonical.formattedText);
	} catch {
		return {
			...canonical,
			valid: false,
			diagnostics: [
				...canonical.diagnostics,
				{
					code: "invalid_wasm_result",
					path: "$",
					message: "The Rust canonicalizer returned invalid formatted JSON",
				},
			],
			value: null,
		};
	}

	const diagnostics = [...canonical.diagnostics];
	const value = decodeDocument(document, diagnostics);
	const valid = canonical.valid && diagnostics.length === 0 && value !== null;
	return {
		...canonical,
		valid,
		diagnostics,
		value: valid ? value : null,
	};
}

function canonicalizeJson({
	json,
	canonicalize: injectedCanonicalizer,
}: {
	json: string;
	canonicalize?: TimelineDocumentV2Canonicalizer;
}): TimelineDocumentV2CanonicalResult {
	const canonicalize =
		injectedCanonicalizer ?? defaultTimelineDocumentV2Canonicalizer;
	if (typeof canonicalize !== "function") {
		return invalidCanonicalResult({
			code: "wasm_export_unavailable",
			path: "$",
			message:
				"canonicalizeTimelineSourceDocument is unavailable; rebuild the opencut-wasm package",
		});
	}

	try {
		const result = canonicalize({ json });
		if (!isRustCanonicalizeResult(result)) {
			return invalidCanonicalResult({
				code: "invalid_wasm_result",
				path: "$",
				message: "The Rust canonicalizer returned an invalid result shape",
			});
		}
		return {
			valid: result.valid,
			formattedText: result.formattedJson,
			baseRevision: result.baseRevision,
			diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	} catch (error) {
		return invalidCanonicalResult({
			code: "wasm_canonicalization_failed",
			path: "$",
			message:
				error instanceof Error
					? `Timeline canonicalization failed: ${error.message}`
					: "Timeline canonicalization failed",
		});
	}
}

function isRustCanonicalizeResult(
	value: unknown,
): value is TimelineDocumentV2CanonicalizerResult {
	if (!isRecord(value)) return false;
	if (
		typeof value.valid !== "boolean" ||
		typeof value.formattedJson !== "string" ||
		typeof value.baseRevision !== "string" ||
		!Array.isArray(value.diagnostics)
	) {
		return false;
	}
	return value.diagnostics.every(
		(diagnostic) =>
			isRecord(diagnostic) &&
			typeof diagnostic.code === "string" &&
			typeof diagnostic.path === "string" &&
			typeof diagnostic.message === "string",
	);
}

function invalidCanonicalResult(
	diagnostic: TimelineDocumentV2Diagnostic,
): TimelineDocumentV2CanonicalResult {
	return {
		valid: false,
		formattedText: "",
		baseRevision: "",
		diagnostics: [diagnostic],
	};
}

function getOrderedTrackEntries(tracks: SceneTracks): OrderedTrackEntry[] {
	const entries: OrderedTrackEntry[] = [
		...tracks.overlay.map((track) => ({ area: "overlay" as const, track })),
		{ area: "main", track: tracks.main },
		...tracks.audio.map((track) => ({ area: "audio" as const, track })),
	];
	const unused = new Set(entries.map((_, index) => index));
	const ordered: OrderedTrackEntry[] = [];

	for (const trackId of tracks.order ?? []) {
		const index = entries.findIndex(
			(entry, candidateIndex) =>
				unused.has(candidateIndex) && entry.track.id === trackId,
		);
		if (index < 0) continue;
		unused.delete(index);
		ordered.push(entries[index]);
	}
	for (const [index, entry] of entries.entries()) {
		if (unused.has(index)) ordered.push(entry);
	}
	return ordered;
}

function serializeTrack({
	area,
	track,
	path,
}: {
	area: TrackArea;
	track: TimelineTrack;
	path: string;
}): JsonObject {
	const elements = track.elements.map((element, elementIndex) =>
		serializeElement(element, `${path}.elements[${elementIndex}]`),
	);
	return cloneJsonObject({ ...track, area, elements }, path);
}

function serializeElement(element: TimelineElement, path: string): JsonObject {
	if (element.type !== "audio") return cloneJsonObject(element, path);
	const { buffer: _runtimeBuffer, ...persistentElement } = element;
	return cloneJsonObject(persistentElement, path);
}

function serializeDate(value: Date, path: string): string {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new JsonSafetyError(path, `${path} must be a valid Date`);
	}
	return value.toISOString();
}

function cloneJsonObject(value: unknown, path: string): JsonObject {
	const cloned = cloneJsonValue(value, path, new Set());
	if (!isRecord(cloned)) {
		throw new JsonSafetyError(path, `${path} must be a JSON object`);
	}
	return cloned as JsonObject;
}

function cloneJsonArray(value: unknown, path: string): JsonValue[] {
	const cloned = cloneJsonValue(value, path, new Set());
	if (!Array.isArray(cloned)) {
		throw new JsonSafetyError(path, `${path} must be a JSON array`);
	}
	return cloned;
}

function cloneJsonValue(
	value: unknown,
	path: string,
	ancestors: Set<object>,
): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new JsonSafetyError(path, `${path} contains a non-finite number`);
		}
		return value;
	}
	if (typeof value !== "object") {
		throw new JsonSafetyError(
			path,
			`${path} contains a non-JSON ${typeof value} value`,
		);
	}
	if (ancestors.has(value)) {
		throw new JsonSafetyError(path, `${path} contains a circular reference`);
	}

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			if (item === undefined) {
				throw new JsonSafetyError(
					`${path}[${index}]`,
					`${path}[${index}] contains undefined`,
				);
			}
			return cloneJsonValue(item, `${path}[${index}]`, nextAncestors);
		});
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new JsonSafetyError(
			path,
			`${path} contains a runtime ${value.constructor?.name ?? "object"} value`,
		);
	}
	const cloned: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		// Optional persisted properties use undefined in memory and are absent in JSON.
		if (child === undefined) continue;
		cloned[key] = cloneJsonValue(child, `${path}.${key}`, nextAncestors);
	}
	return cloned;
}

function decodeDocument(
	value: unknown,
	diagnostics: TimelineDocumentV2Diagnostic[],
): ParsedTimelineDocumentV2 | null {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, "$", "document must be an object");
		return null;
	}
	if (value.schemaVersion !== TIMELINE_DOCUMENT_V2_SCHEMA_VERSION) {
		pushInvalidType(
			diagnostics,
			"$.schemaVersion",
			"schemaVersion must be the integer 2",
		);
	}

	const projectSettings = decodeProjectSettings(
		value.projectSettings,
		diagnostics,
	);
	const scene = value.scene;
	if (!isRecord(scene)) {
		pushInvalidShape(diagnostics, "$.scene", "scene must be an object");
		return null;
	}

	const sceneId = readNonEmptyString(scene.id, "$.scene.id", diagnostics);
	const sceneName = readString(scene.name, "$.scene.name", diagnostics);
	const isMain = readBoolean(scene.isMain, "$.scene.isMain", diagnostics);
	const createdAt = readDate(scene.createdAt, "$.scene.createdAt", diagnostics);
	const updatedAt = readDate(scene.updatedAt, "$.scene.updatedAt", diagnostics);
	const bookmarks = decodeBookmarks(scene.bookmarks, diagnostics);
	const tracks = decodeTracks(scene.tracks, diagnostics);

	if (
		!projectSettings ||
		sceneId === null ||
		sceneName === null ||
		isMain === null ||
		!createdAt ||
		!updatedAt ||
		!bookmarks ||
		!tracks ||
		diagnostics.length > 0
	) {
		return null;
	}

	return {
		projectSettings,
		scene: {
			id: sceneId,
			name: sceneName,
			isMain,
			createdAt,
			updatedAt,
		},
		tracks,
		bookmarks,
	};
}

function decodeProjectSettings(
	value: unknown,
	diagnostics: TimelineDocumentV2Diagnostic[],
): TProjectSettings | null {
	if (!isRecord(value)) {
		pushInvalidShape(
			diagnostics,
			"$.projectSettings",
			"projectSettings must be an object",
		);
		return null;
	}
	const before = diagnostics.length;
	const fps = value.fps;
	if (!isRecord(fps)) {
		pushInvalidShape(
			diagnostics,
			"$.projectSettings.fps",
			"fps must be an object",
		);
	} else {
		readPositiveInteger(
			fps.numerator,
			"$.projectSettings.fps.numerator",
			diagnostics,
		);
		readPositiveInteger(
			fps.denominator,
			"$.projectSettings.fps.denominator",
			diagnostics,
		);
	}
	decodeCanvasSize(
		value.canvasSize,
		"$.projectSettings.canvasSize",
		diagnostics,
	);
	if (
		value.canvasSizeMode !== undefined &&
		value.canvasSizeMode !== "preset" &&
		value.canvasSizeMode !== "custom"
	) {
		pushInvalidType(
			diagnostics,
			"$.projectSettings.canvasSizeMode",
			'canvasSizeMode must be "preset" or "custom"',
		);
	}
	for (const key of ["lastCustomCanvasSize", "originalCanvasSize"] as const) {
		const size = value[key];
		if (size !== undefined && size !== null) {
			decodeCanvasSize(size, `$.projectSettings.${key}`, diagnostics);
		}
	}

	const background = value.background;
	if (!isRecord(background)) {
		pushInvalidShape(
			diagnostics,
			"$.projectSettings.background",
			"background must be an object",
		);
	} else if (background.type === "color") {
		readString(
			background.color,
			"$.projectSettings.background.color",
			diagnostics,
		);
	} else if (background.type === "blur") {
		readFiniteNumber(
			background.blurIntensity,
			"$.projectSettings.background.blurIntensity",
			diagnostics,
		);
	} else {
		pushInvalidType(
			diagnostics,
			"$.projectSettings.background.type",
			'background.type must be "color" or "blur"',
		);
	}

	return diagnostics.length === before
		? (value as unknown as TProjectSettings)
		: null;
}

function decodeCanvasSize(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): void {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, path, `${path} must be an object`);
		return;
	}
	readPositiveInteger(value.width, `${path}.width`, diagnostics);
	readPositiveInteger(value.height, `${path}.height`, diagnostics);
}

function decodeBookmarks(
	value: unknown,
	diagnostics: TimelineDocumentV2Diagnostic[],
): Bookmark[] | null {
	if (!Array.isArray(value)) {
		pushInvalidShape(
			diagnostics,
			"$.scene.bookmarks",
			"scene.bookmarks must be an array",
		);
		return null;
	}
	const before = diagnostics.length;
	for (const [index, bookmark] of value.entries()) {
		const path = `$.scene.bookmarks[${index}]`;
		if (!isRecord(bookmark)) {
			pushInvalidShape(diagnostics, path, "bookmark must be an object");
			continue;
		}
		readNonNegativeInteger(bookmark.time, `${path}.time`, diagnostics);
		if (bookmark.duration !== undefined) {
			readNonNegativeInteger(
				bookmark.duration,
				`${path}.duration`,
				diagnostics,
			);
		}
		if (bookmark.note !== undefined) {
			readString(bookmark.note, `${path}.note`, diagnostics);
		}
		if (bookmark.color !== undefined) {
			readString(bookmark.color, `${path}.color`, diagnostics);
		}
	}
	return diagnostics.length === before ? (value as Bookmark[]) : null;
}

function decodeTracks(
	value: unknown,
	diagnostics: TimelineDocumentV2Diagnostic[],
): SceneTracks | null {
	if (!Array.isArray(value)) {
		pushInvalidShape(
			diagnostics,
			"$.scene.tracks",
			"scene.tracks must be an array",
		);
		return null;
	}

	const overlay: OverlayTrack[] = [];
	const audio: AudioTrack[] = [];
	const order: string[] = [];
	let main: VideoTrack | null = null;
	const trackIds = new Map<string, string>();
	const elementIds = new Map<string, string>();
	const before = diagnostics.length;

	for (const [trackIndex, rawTrack] of value.entries()) {
		const path = `$.scene.tracks[${trackIndex}]`;
		const decoded = decodeTrack(rawTrack, path, diagnostics, elementIds);
		if (!decoded) continue;
		const { area, track } = decoded;
		const firstTrackPath = trackIds.get(track.id);
		if (firstTrackPath) {
			pushDiagnostic(
				diagnostics,
				"duplicate_track_id",
				`${path}.id`,
				`Duplicate track id "${track.id}"; first declared at ${firstTrackPath}`,
			);
		} else {
			trackIds.set(track.id, `${path}.id`);
		}
		order.push(track.id);

		if (area === "main") {
			if (track.type !== "video") {
				pushDiagnostic(
					diagnostics,
					"incompatible_track_area",
					`${path}.area`,
					"Only a video track can occupy the main area",
				);
			} else if (main) {
				pushDiagnostic(
					diagnostics,
					"duplicate_main_track",
					`${path}.area`,
					"A scene must contain exactly one main track",
				);
			} else {
				main = track;
			}
		} else if (area === "audio") {
			if (track.type !== "audio") {
				pushDiagnostic(
					diagnostics,
					"incompatible_track_area",
					`${path}.area`,
					"Only audio tracks can occupy the audio area",
				);
			} else {
				audio.push(track);
			}
		} else if (track.type === "audio") {
			pushDiagnostic(
				diagnostics,
				"incompatible_track_area",
				`${path}.area`,
				"Audio tracks cannot occupy the overlay area",
			);
		} else {
			overlay.push(track);
		}
	}

	if (!main) {
		pushDiagnostic(
			diagnostics,
			"missing_main_track",
			"$.scene.tracks",
			"A scene must contain exactly one main video track",
		);
	}
	if (diagnostics.length !== before || !main) return null;
	return { overlay, main, audio, order };
}

function decodeTrack(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
	elementIds: Map<string, string>,
): { area: TrackArea; track: TimelineTrack } | null {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, path, "track must be an object");
		return null;
	}
	const before = diagnostics.length;
	const id = readNonEmptyString(value.id, `${path}.id`, diagnostics);
	readString(value.name, `${path}.name`, diagnostics);
	const type = readTrackType(value.type, `${path}.type`, diagnostics);
	const area = readTrackArea(value.area, `${path}.area`, diagnostics);

	if (type === "video") {
		readBoolean(value.muted, `${path}.muted`, diagnostics);
		readBoolean(value.hidden, `${path}.hidden`, diagnostics);
	} else if (type === "audio") {
		readBoolean(value.muted, `${path}.muted`, diagnostics);
	} else if (type) {
		readBoolean(value.hidden, `${path}.hidden`, diagnostics);
	}
	if (type === "text" && value.captionSource !== undefined) {
		validateCaptionSource(
			value.captionSource,
			`${path}.captionSource`,
			diagnostics,
		);
	}

	if (!Array.isArray(value.elements)) {
		pushInvalidShape(
			diagnostics,
			`${path}.elements`,
			"track.elements must be an array",
		);
	} else if (type) {
		for (const [elementIndex, element] of value.elements.entries()) {
			const elementPath = `${path}.elements[${elementIndex}]`;
			const elementId = decodeElement(element, type, elementPath, diagnostics);
			if (!elementId) continue;
			const firstElementPath = elementIds.get(elementId);
			if (firstElementPath) {
				pushDiagnostic(
					diagnostics,
					"duplicate_element_id",
					`${elementPath}.id`,
					`Duplicate element id "${elementId}"; first declared at ${firstElementPath}`,
				);
			} else {
				elementIds.set(elementId, `${elementPath}.id`);
			}
		}
	}

	if (
		diagnostics.length !== before ||
		!id ||
		!type ||
		!area ||
		!Array.isArray(value.elements)
	) {
		return null;
	}
	const { area: _area, ...persistentTrack } = value;
	return { area, track: persistentTrack as unknown as TimelineTrack };
}

function validateCaptionSource(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): void {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, path, "captionSource must be an object");
		return;
	}
	if (!Array.isArray(value.words)) {
		pushInvalidShape(
			diagnostics,
			`${path}.words`,
			"captionSource.words must be an array",
		);
	}
	if (!isRecord(value.settings)) {
		pushInvalidShape(
			diagnostics,
			`${path}.settings`,
			"captionSource.settings must be an object",
		);
	}
	if (value.sourceId !== undefined) {
		readString(value.sourceId, `${path}.sourceId`, diagnostics);
	}
	for (const key of ["layerIndex", "layerCount"] as const) {
		if (value[key] !== undefined) {
			readNonNegativeInteger(value[key], `${path}.${key}`, diagnostics);
		}
	}
}

const ELEMENT_TYPES_BY_TRACK = {
	video: new Set(["video", "image"]),
	text: new Set(["text"]),
	audio: new Set(["audio"]),
	graphic: new Set(["graphic", "sticker"]),
	effect: new Set(["effect"]),
} satisfies Record<TimelineTrack["type"], Set<string>>;

function decodeElement(
	value: unknown,
	trackType: TimelineTrack["type"],
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): string | null {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, path, "element must be an object");
		return null;
	}
	const id = readNonEmptyString(value.id, `${path}.id`, diagnostics);
	readString(value.name, `${path}.name`, diagnostics);
	const elementType = readElementType(value.type, `${path}.type`, diagnostics);
	readNonNegativeInteger(value.startTime, `${path}.startTime`, diagnostics);
	readNonNegativeInteger(value.duration, `${path}.duration`, diagnostics);
	readNonNegativeInteger(value.trimStart, `${path}.trimStart`, diagnostics);
	readNonNegativeInteger(value.trimEnd, `${path}.trimEnd`, diagnostics);
	if (value.sourceDuration !== undefined) {
		readNonNegativeInteger(
			value.sourceDuration,
			`${path}.sourceDuration`,
			diagnostics,
		);
	}
	validateParams(value.params, `${path}.params`, diagnostics);

	if (elementType && !ELEMENT_TYPES_BY_TRACK[trackType].has(elementType)) {
		pushDiagnostic(
			diagnostics,
			"incompatible_element_type",
			`${path}.type`,
			`${elementType} elements cannot be placed on ${trackType} tracks`,
		);
	}

	if (elementType === "video" || elementType === "image") {
		readNonEmptyString(value.mediaId, `${path}.mediaId`, diagnostics);
	} else if (elementType === "audio") {
		if (Object.prototype.hasOwnProperty.call(value, "buffer")) {
			pushDiagnostic(
				diagnostics,
				"runtime_field_not_allowed",
				`${path}.buffer`,
				"AudioElement.buffer is runtime-only and cannot appear in Timeline Source",
			);
		}
		if (value.sourceType === "upload") {
			readNonEmptyString(value.mediaId, `${path}.mediaId`, diagnostics);
		} else if (value.sourceType !== "library") {
			pushInvalidType(
				diagnostics,
				`${path}.sourceType`,
				'audio sourceType must be "upload" or "library"',
			);
		}
	} else if (elementType === "graphic") {
		readNonEmptyString(value.definitionId, `${path}.definitionId`, diagnostics);
	} else if (elementType === "sticker") {
		readNonEmptyString(value.stickerId, `${path}.stickerId`, diagnostics);
	} else if (elementType === "effect") {
		readNonEmptyString(value.effectType, `${path}.effectType`, diagnostics);
	}

	return id;
}

function validateParams(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): void {
	if (!isRecord(value)) {
		pushInvalidShape(diagnostics, path, "element.params must be an object");
		return;
	}
	for (const [key, param] of Object.entries(value)) {
		if (
			typeof param !== "string" &&
			typeof param !== "boolean" &&
			!(typeof param === "number" && Number.isFinite(param))
		) {
			pushInvalidType(
				diagnostics,
				`${path}.${key}`,
				"parameter values must be finite numbers, strings, or booleans",
			);
		}
	}
}

function readTrackType(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): TimelineTrack["type"] | null {
	if (
		value === "video" ||
		value === "text" ||
		value === "audio" ||
		value === "graphic" ||
		value === "effect"
	) {
		return value;
	}
	pushInvalidType(
		diagnostics,
		path,
		"track.type must be video, text, audio, graphic, or effect",
	);
	return null;
}

function readElementType(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): TimelineElement["type"] | null {
	if (
		value === "video" ||
		value === "image" ||
		value === "text" ||
		value === "audio" ||
		value === "graphic" ||
		value === "sticker" ||
		value === "effect"
	) {
		return value;
	}
	pushInvalidType(diagnostics, path, "unsupported timeline element type");
	return null;
}

function readTrackArea(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): TrackArea | null {
	if (value === "overlay" || value === "main" || value === "audio")
		return value;
	pushInvalidType(
		diagnostics,
		path,
		'track.area must be "overlay", "main", or "audio"',
	);
	return null;
}

function readNonEmptyString(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): string | null {
	if (typeof value === "string" && value.trim().length > 0) return value;
	pushInvalidType(diagnostics, path, `${path} must be a non-empty string`);
	return null;
}

function readString(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): string | null {
	if (typeof value === "string") return value;
	pushInvalidType(diagnostics, path, `${path} must be a string`);
	return null;
}

function readBoolean(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): boolean | null {
	if (typeof value === "boolean") return value;
	pushInvalidType(diagnostics, path, `${path} must be a boolean`);
	return null;
}

function readFiniteNumber(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	pushInvalidType(diagnostics, path, `${path} must be a finite number`);
	return null;
}

function readPositiveInteger(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	pushInvalidType(diagnostics, path, `${path} must be a positive integer`);
	return null;
}

function readNonNegativeInteger(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	pushInvalidType(diagnostics, path, `${path} must be a non-negative integer`);
	return null;
}

function readDate(
	value: unknown,
	path: string,
	diagnostics: TimelineDocumentV2Diagnostic[],
): Date | null {
	if (typeof value === "string") {
		const date = new Date(value);
		if (Number.isFinite(date.getTime())) return date;
	}
	pushInvalidType(diagnostics, path, `${path} must be a valid date string`);
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushInvalidShape(
	diagnostics: TimelineDocumentV2Diagnostic[],
	path: string,
	message: string,
): void {
	pushDiagnostic(diagnostics, "invalid_shape", path, message);
}

function pushInvalidType(
	diagnostics: TimelineDocumentV2Diagnostic[],
	path: string,
	message: string,
): void {
	pushDiagnostic(diagnostics, "invalid_type", path, message);
}

function pushDiagnostic(
	diagnostics: TimelineDocumentV2Diagnostic[],
	code: string,
	path: string,
	message: string,
): void {
	diagnostics.push({ code, path, message });
}
