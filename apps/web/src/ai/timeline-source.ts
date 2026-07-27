/**
 * Timeline-as-code: a deterministic, line-oriented text projection of the
 * scene that the AI edits like a source file (openclaw-style oldText/newText
 * replacements). The edited text is parsed back and diffed against the
 * original to derive AiEditOperations mechanically - the model never has to
 * reproduce the timeline, only patch it.
 *
 * Format: one JSON object per line, prefixed by a keyword.
 *   track {"id":"1a2b3c4d","area":"overlay","kind":"text","name":"Captions"}
 *   el {"id":"5e6f7a8b","track":"1a2b3c4d","type":"text","at":1.5,"dur":4,...}
 *   kf {"id":"9c0d1e2f","el":"5e6f7a8b","path":"opacity","at":0.5,"v":1}
 * Times are seconds; ids are shortened but stable within one document.
 */

import type { SceneTracks, TimelineElement, TrackType } from "@/timeline/types";
import { getDisplayTracks } from "@/timeline/track-order";
import type { MediaAsset } from "@/media/types";
import { getBuiltInElementParams } from "@/params/registry";
import { buildDefaultParamValues } from "@/params/registry";
import { getGraphicDefinition } from "@/graphics";
import { HYPERFRAME_DEFINITION_ID } from "@/graphics/definitions/hyperframe";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import type { AiEditOperation } from "./types";

const SOURCE_HEADER = [
	"# OPENCUT TIMELINE SOURCE v1 - edit this like a code file.",
	'# One JSON object per line. Times are SECONDS. Never change or reuse "id" values.',
	"# Change a value in place to edit. Delete a line to delete that thing.",
	'# Insert an element: add a line: el {"id":"new","type":"text|html|graphic|media",...}. Use new-1, new-2, ... for multiple inserts.',
	'# Insert a keyframe: add a line: kf {"id":"new","el":"<element id>","path":"...","at":<s>,"v":...}.',
	'# Duplicate an element: copy its line and change the copy\'s id to "new".',
	"# el fields: track, at (start), dur, name, text (text content), html, media (asset id), graphic (definition id), params, hidden, muted, rate (speed), tin/tout (transition preset ids), tinDur/toutDur (seconds).",
	"#",
].join("\n");

interface SourceTrackLine {
	id: string;
	area: "overlay" | "main" | "audio";
	kind: TrackType;
	name?: string;
	hidden?: boolean;
	muted?: boolean;
}

interface SourceElementLine {
	id: string;
	track?: string;
	type: string;
	at: number;
	dur: number;
	name?: string;
	text?: string;
	html?: string;
	w?: number;
	h?: number;
	media?: string;
	src?: string;
	graphic?: string;
	sticker?: string;
	params?: Record<string, string | number | boolean>;
	hidden?: boolean;
	muted?: boolean;
	rate?: number;
	tin?: string;
	tinDur?: number;
	tout?: string;
	toutDur?: number;
}

interface SourceKeyframeLine {
	id: string;
	el: string;
	path: string;
	at: number;
	v: string | number | boolean;
	interp?: string;
}

export interface ParsedTimelineSource {
	tracks: SourceTrackLine[];
	elements: SourceElementLine[];
	keyframes: SourceKeyframeLine[];
	errors: string[];
}

export interface TimelineSourceState {
	text: string;
	/** short id -> full id */
	idMap: Map<string, string>;
}

export interface TimelineSourceDiffResult {
	operations: AiEditOperation[];
	notes: string[];
	errors: string[];
}

function secondsFromTicks(ticks: number): number {
	return Math.round((ticks / TICKS_PER_SECOND) * 1_000_000) / 1_000_000;
}

function ticksFromSeconds(seconds: number): MediaTime {
	return Math.max(
		0,
		Math.round(seconds * TICKS_PER_SECOND),
	) as unknown as MediaTime;
}

function buildShortIdAllocator(): {
	shorten: (fullId: string) => string;
	idMap: Map<string, string>;
} {
	const idMap = new Map<string, string>();
	const used = new Set<string>();
	const shorten = (fullId: string): string => {
		const compact = fullId.replace(/-/g, "");
		for (let length = 8; length <= compact.length; length += 4) {
			const candidate = compact.slice(0, length);
			if (!used.has(candidate)) {
				used.add(candidate);
				idMap.set(candidate, fullId);
				return candidate;
			}
			if (idMap.get(candidate) === fullId) {
				return candidate;
			}
		}
		used.add(fullId);
		idMap.set(fullId, fullId);
		return fullId;
	};
	return { shorten, idMap };
}

function getDefaultParamsForElement(
	element: TimelineElement,
): Record<string, string | number | boolean> {
	const defaults: Record<string, string | number | boolean> = {};
	const builtIn = buildDefaultParamValues(
		getBuiltInElementParams({ type: element.type }),
	);
	for (const [key, value] of Object.entries(builtIn)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			defaults[key] = value;
		}
	}
	if (element.type === "graphic") {
		try {
			const definition = getGraphicDefinition({
				definitionId: element.definitionId,
			});
			for (const param of definition.params) {
				const value = param.default;
				if (
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean"
				) {
					defaults[param.key] = value;
				}
			}
		} catch {
			// Unknown definition: keep built-in defaults only.
		}
	}
	return defaults;
}

const OWN_FIELD_PARAM_KEYS = new Set([
	"content",
	"html",
	"sourceWidth",
	"sourceHeight",
]);

function serializeElementParams(
	element: TimelineElement,
): Record<string, string | number | boolean> {
	const defaults = getDefaultParamsForElement(element);
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(element.params)) {
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			continue;
		}
		if (OWN_FIELD_PARAM_KEYS.has(key)) {
			continue;
		}
		if (defaults[key] === value) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

function collectElementKeyframes({
	element,
	shorten,
}: {
	element: TimelineElement;
	shorten: (fullId: string) => string;
}): SourceKeyframeLine[] {
	const animations =
		"animations" in element ? (element.animations ?? undefined) : undefined;
	if (!animations) {
		return [];
	}
	const lines: SourceKeyframeLine[] = [];
	const visit = ({
		propertyPath,
		channelData,
	}: {
		propertyPath: string;
		channelData: unknown;
	}): void => {
		if (typeof channelData !== "object" || channelData === null) {
			return;
		}
		const record = channelData as Record<string, unknown>;
		if (Array.isArray(record.keys)) {
			for (const keyframe of record.keys) {
				if (typeof keyframe !== "object" || keyframe === null) continue;
				const kf = keyframe as Record<string, unknown>;
				const keyframeId = typeof kf.id === "string" ? kf.id : null;
				const time = typeof kf.time === "number" ? kf.time : null;
				const value = kf.value;
				if (
					!keyframeId ||
					time === null ||
					(typeof value !== "string" &&
						typeof value !== "number" &&
						typeof value !== "boolean")
				) {
					continue;
				}
				lines.push({
					id: shorten(keyframeId),
					el: shorten(element.id),
					path: propertyPath,
					at: secondsFromTicks(time),
					v: value,
					...(typeof kf.segmentToNext === "string" &&
					kf.segmentToNext !== "linear"
						? { interp: kf.segmentToNext }
						: {}),
				});
			}
			return;
		}
		for (const nested of Object.values(record)) {
			visit({ propertyPath, channelData: nested });
		}
	};
	for (const [propertyPath, channelData] of Object.entries(animations)) {
		visit({ propertyPath, channelData });
	}
	return lines;
}

function serializeElementLine({
	element,
	trackShortId,
	shorten,
}: {
	element: TimelineElement;
	trackShortId: string;
	shorten: (fullId: string) => string;
}): SourceElementLine {
	const isHyperframe =
		element.type === "graphic" &&
		element.definitionId === HYPERFRAME_DEFINITION_ID;
	const line: SourceElementLine = {
		id: shorten(element.id),
		track: trackShortId,
		type: isHyperframe ? "html" : element.type,
		at: secondsFromTicks(element.startTime),
		dur: secondsFromTicks(element.duration),
		name: element.name,
	};

	if (element.type === "text") {
		const content = element.params.content;
		if (typeof content === "string") {
			line.text = content;
		}
	}
	if (isHyperframe) {
		const html = element.params.html;
		if (typeof html === "string") {
			line.html = html;
		}
		if (typeof element.params.sourceWidth === "number") {
			line.w = element.params.sourceWidth;
		}
		if (typeof element.params.sourceHeight === "number") {
			line.h = element.params.sourceHeight;
		}
	} else if (element.type === "graphic") {
		line.graphic = element.definitionId;
	}
	if (element.type === "video" || element.type === "image") {
		line.media = element.mediaId;
	}
	if (element.type === "audio") {
		if (element.sourceType === "upload") {
			line.media = element.mediaId;
		} else {
			line.src = element.sourceUrl;
		}
	}
	if (element.type === "sticker") {
		line.sticker = element.stickerId;
	}

	const params = serializeElementParams(element);
	if (Object.keys(params).length > 0) {
		line.params = params;
	}
	if ("hidden" in element && element.hidden) {
		line.hidden = true;
	}
	if (
		(element.type === "audio" || element.type === "video") &&
		element.params.muted === true
	) {
		line.muted = true;
	}
	if (
		(element.type === "audio" || element.type === "video") &&
		element.retime &&
		element.retime.rate !== 1
	) {
		line.rate = element.retime.rate;
	}
	if ("transitions" in element && element.transitions) {
		if (element.transitions.in) {
			line.tin = element.transitions.in.presetId;
			line.tinDur = secondsFromTicks(element.transitions.in.duration);
		}
		if (element.transitions.out) {
			line.tout = element.transitions.out.presetId;
			line.toutDur = secondsFromTicks(element.transitions.out.duration);
		}
	}
	return line;
}

export function serializeTimelineSource({
	tracks,
}: {
	tracks: SceneTracks;
	mediaAssets?: MediaAsset[];
}): TimelineSourceState {
	const { shorten, idMap } = buildShortIdAllocator();
	const displayTracks = getDisplayTracks({ tracks });
	const lines: string[] = [SOURCE_HEADER];

	for (const track of displayTracks) {
		const area =
			track.id === tracks.main.id
				? "main"
				: track.type === "audio"
					? "audio"
					: "overlay";
		const trackShortId = shorten(track.id);
		const trackLine: SourceTrackLine = {
			id: trackShortId,
			area,
			kind: track.type,
			name: track.name,
			...("hidden" in track && track.hidden ? { hidden: true } : {}),
			...("muted" in track && track.muted ? { muted: true } : {}),
		};
		lines.push(`track ${JSON.stringify(trackLine)}`);
		for (const element of track.elements) {
			lines.push(
				`el ${JSON.stringify(
					serializeElementLine({ element, trackShortId, shorten }),
				)}`,
			);
			for (const keyframe of collectElementKeyframes({ element, shorten })) {
				lines.push(`kf ${JSON.stringify(keyframe)}`);
			}
		}
	}

	return { text: `${lines.join("\n")}\n`, idMap };
}

export function parseTimelineSource({
	text,
}: {
	text: string;
}): ParsedTimelineSource {
	const parsed: ParsedTimelineSource = {
		tracks: [],
		elements: [],
		keyframes: [],
		errors: [],
	};
	const lines = text.split("\n");
	for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
		const raw = lines[lineNumber - 1] ?? "";
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const spaceIndex = line.indexOf(" ");
		const keyword = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
		const payload = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1).trim();
		if (keyword !== "track" && keyword !== "el" && keyword !== "kf") {
			parsed.errors.push(
				`Line ${lineNumber}: unknown keyword "${keyword}". Lines must start with track, el, kf, or #.`,
			);
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(payload);
		} catch {
			parsed.errors.push(
				`Line ${lineNumber}: invalid JSON after "${keyword}".`,
			);
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			parsed.errors.push(`Line ${lineNumber}: expected a JSON object.`);
			continue;
		}
		const record = value as Record<string, unknown>;
		if (keyword === "track") {
			const track = readTrackLine({
				record,
				lineNumber,
				errors: parsed.errors,
			});
			if (track) parsed.tracks.push(track);
		} else if (keyword === "el") {
			const element = readElementLine({
				record,
				lineNumber,
				errors: parsed.errors,
			});
			if (element) parsed.elements.push(element);
		} else {
			const keyframe = readKeyframeLine({
				record,
				lineNumber,
				errors: parsed.errors,
			});
			if (keyframe) parsed.keyframes.push(keyframe);
		}
	}
	return parsed;
}

function readString({
	record,
	key,
}: {
	record: Record<string, unknown>;
	key: string;
}) {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber({
	record,
	key,
}: {
	record: Record<string, unknown>;
	key: string;
}) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function readBoolean({
	record,
	key,
}: {
	record: Record<string, unknown>;
	key: string;
}) {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function readTrackLine({
	record,
	lineNumber,
	errors,
}: {
	record: Record<string, unknown>;
	lineNumber: number;
	errors: string[];
}): SourceTrackLine | null {
	const id = readString({ record, key: "id" });
	const kind = readString({ record, key: "kind" });
	if (!id) {
		errors.push(`Line ${lineNumber}: track needs an "id".`);
		return null;
	}
	if (
		kind !== "video" &&
		kind !== "text" &&
		kind !== "audio" &&
		kind !== "graphic" &&
		kind !== "effect"
	) {
		errors.push(
			`Line ${lineNumber}: track "kind" must be video, text, audio, graphic, or effect.`,
		);
		return null;
	}
	const area = readString({ record, key: "area" });
	return {
		id,
		kind,
		area:
			area === "main" || area === "audio" || area === "overlay"
				? area
				: "overlay",
		name: readString({ record, key: "name" }),
		hidden: readBoolean({ record, key: "hidden" }),
		muted: readBoolean({ record, key: "muted" }),
	};
}

function readElementLine({
	record,
	lineNumber,
	errors,
}: {
	record: Record<string, unknown>;
	lineNumber: number;
	errors: string[];
}): SourceElementLine | null {
	const id = readString({ record, key: "id" });
	const type = readString({ record, key: "type" });
	const at = readNumber({ record, key: "at" });
	const dur = readNumber({ record, key: "dur" });
	if (!id || !type) {
		errors.push(`Line ${lineNumber}: el needs "id" and "type".`);
		return null;
	}
	if (at === undefined || dur === undefined || dur <= 0) {
		errors.push(
			`Line ${lineNumber}: el needs numeric "at" (>= 0 seconds) and "dur" (> 0 seconds).`,
		);
		return null;
	}
	const params: Record<string, string | number | boolean> = {};
	const rawParams = record.params;
	if (typeof rawParams === "object" && rawParams !== null) {
		for (const [key, value] of Object.entries(
			rawParams as Record<string, unknown>,
		)) {
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				params[key] = value;
			}
		}
	}
	return {
		id,
		type,
		at,
		dur,
		track: readString({ record, key: "track" }),
		name: readString({ record, key: "name" }),
		text: readString({ record, key: "text" }),
		html: readString({ record, key: "html" }),
		w: readNumber({ record, key: "w" }),
		h: readNumber({ record, key: "h" }),
		media: readString({ record, key: "media" }),
		src: readString({ record, key: "src" }),
		graphic: readString({ record, key: "graphic" }),
		sticker: readString({ record, key: "sticker" }),
		params: Object.keys(params).length > 0 ? params : undefined,
		hidden: readBoolean({ record, key: "hidden" }),
		muted: readBoolean({ record, key: "muted" }),
		rate: readNumber({ record, key: "rate" }),
		tin: readString({ record, key: "tin" }),
		tinDur: readNumber({ record, key: "tinDur" }),
		tout: readString({ record, key: "tout" }),
		toutDur: readNumber({ record, key: "toutDur" }),
	};
}

function readKeyframeLine({
	record,
	lineNumber,
	errors,
}: {
	record: Record<string, unknown>;
	lineNumber: number;
	errors: string[];
}): SourceKeyframeLine | null {
	const id = readString({ record, key: "id" });
	const el = readString({ record, key: "el" });
	const path =
		readString({ record, key: "path" }) ??
		readString({ record, key: "property" });
	const at = readNumber({ record, key: "at" });
	const value = record.v ?? record.value;
	if (!id || !el || !path || at === undefined) {
		errors.push(
			`Line ${lineNumber}: kf needs "id", "el", "path", and numeric "at".`,
		);
		return null;
	}
	if (
		typeof value !== "string" &&
		typeof value !== "number" &&
		typeof value !== "boolean"
	) {
		errors.push(`Line ${lineNumber}: kf needs a scalar "v" value.`);
		return null;
	}
	return {
		id,
		el,
		path,
		at,
		v: value,
		interp: readString({ record, key: "interp" }),
	};
}

function isNewId(id: string): boolean {
	return id === "new" || id.startsWith("new-") || id.startsWith("new_");
}

function resolveFullId({
	shortId,
	idMap,
}: {
	shortId: string;
	idMap: Map<string, string>;
}): string | null {
	return idMap.get(shortId) ?? null;
}

export function diffTimelineSource({
	before,
	after,
	idMap,
}: {
	before: ParsedTimelineSource;
	after: ParsedTimelineSource;
	idMap: Map<string, string>;
}): TimelineSourceDiffResult {
	const operations: AiEditOperation[] = [];
	const notes: string[] = [];
	const errors: string[] = [...after.errors];

	const resolve = (shortId: string) => resolveFullId({ shortId, idMap });
	const beforeTracks = new Map(before.tracks.map((track) => [track.id, track]));
	const afterTracks = new Map(after.tracks.map((track) => [track.id, track]));
	const beforeElements = new Map(
		before.elements.map((element) => [element.id, element]),
	);
	const afterElements = new Map(
		after.elements.map((element) => [element.id, element]),
	);
	const beforeKeyframes = new Map(
		before.keyframes.map((keyframe) => [keyframe.id, keyframe]),
	);
	const afterKeyframes = new Map(
		after.keyframes.map((keyframe) => [keyframe.id, keyframe]),
	);

	const resolveTrackRef = (shortId: string | undefined): string | undefined => {
		if (!shortId || isNewId(shortId)) {
			return undefined;
		}
		return resolve(shortId) ?? undefined;
	};

	const seenElementIds = new Set<string>();
	for (const element of after.elements) {
		if (isNewId(element.id)) {
			continue;
		}
		if (seenElementIds.has(element.id)) {
			errors.push(
				`Element id ${element.id} appears more than once. To duplicate an element, copy its line and change the copy's id to "new".`,
			);
		}
		seenElementIds.add(element.id);
	}

	// --- Tracks: additions, state changes, removals, reorders -------------
	for (const track of after.tracks) {
		if (isNewId(track.id) || !beforeTracks.has(track.id)) {
			if (!isNewId(track.id) && resolve(track.id)) {
				errors.push(
					`Track ${track.id} was moved or renamed by id; ids must not change. Use a "new" id to add tracks.`,
				);
				continue;
			}
			operations.push({ type: "add_track", trackType: track.kind });
			continue;
		}
		const previous = beforeTracks.get(track.id);
		if (!previous) continue;
		if (previous.kind !== track.kind) {
			errors.push(
				`Track ${track.id}: changing "kind" is not supported. Add a new track instead.`,
			);
		}
		if (previous.name !== track.name) {
			notes.push(
				`Track ${track.id}: renaming tracks is not supported yet; name change ignored.`,
			);
		}
		const fullId = resolve(track.id);
		if (!fullId) continue;
		const hiddenChanged =
			(previous.hidden ?? false) !== (track.hidden ?? false);
		const mutedChanged = (previous.muted ?? false) !== (track.muted ?? false);
		if (hiddenChanged || mutedChanged) {
			operations.push({
				type: "set_track_state",
				trackId: fullId,
				...(hiddenChanged ? { hidden: track.hidden ?? false } : {}),
				...(mutedChanged ? { muted: track.muted ?? false } : {}),
			});
		}
	}
	const removedTrackOps: AiEditOperation[] = [];
	for (const track of before.tracks) {
		if (!afterTracks.has(track.id)) {
			const fullId = resolve(track.id);
			if (fullId) {
				removedTrackOps.push({ type: "remove_track", trackId: fullId });
			}
		}
	}
	// Reorders among tracks present in both versions.
	const sharedBeforeOrder = before.tracks
		.filter((track) => afterTracks.has(track.id))
		.map((track) => track.id);
	const sharedAfterOrder = after.tracks
		.filter((track) => beforeTracks.has(track.id))
		.map((track) => track.id);
	if (sharedBeforeOrder.join("|") !== sharedAfterOrder.join("|")) {
		for (const [targetIndex, shortId] of sharedAfterOrder.entries()) {
			if (sharedBeforeOrder[targetIndex] !== shortId) {
				const fullId = resolve(shortId);
				if (fullId) {
					operations.push({
						type: "reorder_track",
						trackId: fullId,
						toIndex: targetIndex,
					});
				}
			}
		}
	}

	// --- Elements ----------------------------------------------------------
	for (const element of after.elements) {
		if (isNewId(element.id) || !beforeElements.has(element.id)) {
			if (!isNewId(element.id) && resolve(element.id)) {
				errors.push(
					`Element ${element.id} exists but its line was rewritten with a different id or moved wholesale; edit values in place instead.`,
				);
				continue;
			}
			const insertOps = buildInsertOperations({
				element,
				resolveTrackRef,
				errors,
			});
			operations.push(...insertOps);
			continue;
		}
		const previous = beforeElements.get(element.id);
		const fullId = resolve(element.id);
		const previousTrackFullId = resolveTrackRef(previous?.track);
		if (!previous || !fullId || !previousTrackFullId) continue;

		if (previous.type !== element.type) {
			errors.push(
				`Element ${element.id}: changing "type" is not supported. Delete the line and add a new element.`,
			);
			continue;
		}

		const targetTrackFullId =
			resolveTrackRef(element.track) ?? previousTrackFullId;
		const atChanged =
			ticksFromSeconds(previous.at) !== ticksFromSeconds(element.at);
		const trackChanged = targetTrackFullId !== previousTrackFullId;
		if (atChanged || trackChanged) {
			operations.push({
				type: "move_element",
				sourceTrackId: previousTrackFullId,
				targetTrackId: targetTrackFullId,
				elementId: fullId,
				startTime: ticksFromSeconds(element.at),
			});
		}
		const trackIdForOps = targetTrackFullId;
		if (ticksFromSeconds(previous.dur) !== ticksFromSeconds(element.dur)) {
			operations.push({
				type: "trim_element",
				trackId: trackIdForOps,
				elementId: fullId,
				startTime: ticksFromSeconds(element.at),
				duration: ticksFromSeconds(element.dur),
			});
		}

		const patchParams: Record<string, string | number | boolean> = {};
		for (const [key, value] of Object.entries(element.params ?? {})) {
			if ((previous.params ?? {})[key] !== value) {
				patchParams[key] = value;
			}
		}
		for (const key of Object.keys(previous.params ?? {})) {
			if (element.params === undefined || !(key in element.params)) {
				notes.push(
					`Element ${element.id}: removing param "${key}" is ignored; set an explicit value instead.`,
				);
			}
		}
		if (element.text !== previous.text && element.text !== undefined) {
			patchParams.content = element.text;
		}
		if (element.html !== previous.html && element.html !== undefined) {
			patchParams.html = element.html;
		}
		if (element.w !== previous.w && element.w !== undefined) {
			patchParams.sourceWidth = element.w;
		}
		if (element.h !== previous.h && element.h !== undefined) {
			patchParams.sourceHeight = element.h;
		}
		const patch: Record<string, unknown> = {};
		if (Object.keys(patchParams).length > 0) {
			patch.params = patchParams;
		}
		if (element.name !== previous.name && element.name !== undefined) {
			patch.name = element.name;
		}
		if (Object.keys(patch).length > 0) {
			operations.push({
				type: "update_element",
				trackId: trackIdForOps,
				elementId: fullId,
				patch,
			});
		}

		const hiddenChanged =
			(previous.hidden ?? false) !== (element.hidden ?? false);
		const mutedChanged = (previous.muted ?? false) !== (element.muted ?? false);
		if (hiddenChanged || mutedChanged) {
			operations.push({
				type: "set_element_state",
				trackId: trackIdForOps,
				elementId: fullId,
				...(hiddenChanged ? { hidden: element.hidden ?? false } : {}),
				...(mutedChanged ? { muted: element.muted ?? false } : {}),
			});
		}
		if ((previous.rate ?? 1) !== (element.rate ?? 1)) {
			operations.push({
				type: "retime_element",
				trackId: trackIdForOps,
				elementId: fullId,
				rate: element.rate ?? 1,
			});
		}
		for (const side of ["in", "out"] as const) {
			const presetKey = side === "in" ? "tin" : "tout";
			const durKey = side === "in" ? "tinDur" : "toutDur";
			const previousPreset = previous[presetKey];
			const nextPreset = element[presetKey];
			const previousDur = previous[durKey];
			const nextDur = element[durKey];
			if (previousPreset === nextPreset && previousDur === nextDur) {
				continue;
			}
			const percent =
				nextDur !== undefined && element.dur > 0
					? Math.min(100, Math.max(0, (nextDur / element.dur) * 100))
					: undefined;
			operations.push({
				type: "apply_transition",
				trackId: trackIdForOps,
				elementId: fullId,
				presetId: nextPreset ?? "none",
				side,
				...(percent !== undefined ? { percent } : {}),
			});
		}
	}
	const deleteOps: AiEditOperation[] = [];
	for (const element of before.elements) {
		if (!afterElements.has(element.id)) {
			const fullId = resolve(element.id);
			const trackFullId = resolveTrackRef(element.track);
			if (fullId && trackFullId) {
				deleteOps.push({
					type: "delete_element",
					trackId: trackFullId,
					elementId: fullId,
				});
			}
		}
	}

	// --- Keyframes ----------------------------------------------------------
	for (const keyframe of after.keyframes) {
		const elementLine =
			afterElements.get(keyframe.el) ?? beforeElements.get(keyframe.el);
		const elementFullId = resolve(keyframe.el);
		const trackFullId = resolveTrackRef(
			elementLine?.track ?? beforeElements.get(keyframe.el)?.track,
		);
		if (!elementFullId || !trackFullId) {
			if (!isNewId(keyframe.el)) {
				errors.push(
					`Keyframe ${keyframe.id}: unknown element ${keyframe.el}. Keyframes can only target existing elements.`,
				);
			} else {
				notes.push(
					`Keyframe ${keyframe.id} targets a new element; add the element first, then keyframe it in a follow-up edit.`,
				);
			}
			continue;
		}
		const previous = isNewId(keyframe.id)
			? undefined
			: beforeKeyframes.get(keyframe.id);
		if (previous) {
			const changed =
				previous.path !== keyframe.path ||
				ticksFromSeconds(previous.at) !== ticksFromSeconds(keyframe.at) ||
				previous.v !== keyframe.v ||
				(previous.interp ?? "linear") !== (keyframe.interp ?? "linear");
			if (!changed) {
				continue;
			}
			if (previous.path !== keyframe.path) {
				errors.push(
					`Keyframe ${keyframe.id}: changing "path" is not supported. Delete the line and add a new keyframe.`,
				);
				continue;
			}
		}
		operations.push({
			type: "upsert_keyframe",
			trackId: trackFullId,
			elementId: elementFullId,
			propertyPath: keyframe.path,
			time: ticksFromSeconds(keyframe.at),
			value: keyframe.v,
			...(keyframe.interp === "hold" ? { interpolation: "hold" as const } : {}),
			...(previous ? { keyframeId: resolve(keyframe.id) ?? undefined } : {}),
		});
	}
	for (const keyframe of before.keyframes) {
		if (!afterKeyframes.has(keyframe.id)) {
			const elementFullId = resolve(keyframe.el);
			const trackFullId = resolveTrackRef(
				beforeElements.get(keyframe.el)?.track,
			);
			const keyframeFullId = resolve(keyframe.id);
			if (elementFullId && trackFullId && keyframeFullId) {
				operations.push({
					type: "remove_keyframe",
					trackId: trackFullId,
					elementId: elementFullId,
					propertyPath: keyframe.path,
					keyframeId: keyframeFullId,
				});
			}
		}
	}

	operations.push(...deleteOps, ...removedTrackOps);
	return { operations, notes, errors };
}

function buildInsertOperations({
	element,
	resolveTrackRef,
	errors,
}: {
	element: SourceElementLine;
	resolveTrackRef: (shortId: string | undefined) => string | undefined;
	errors: string[];
}): AiEditOperation[] {
	const startTime = ticksFromSeconds(element.at);
	const duration = ticksFromSeconds(element.dur);
	const trackId = resolveTrackRef(element.track);

	if (element.type === "text") {
		const content = element.text ?? "";
		if (!content.trim()) {
			errors.push(
				`New element ${element.id}: text elements need a non-empty "text" field.`,
			);
			return [];
		}
		return [
			{
				type: "insert_text_element",
				content,
				startTime,
				duration,
				...(trackId ? { trackId } : {}),
				...(element.name ? { name: element.name } : {}),
				...(element.params ? { params: element.params } : {}),
			},
		];
	}
	if (element.type === "html") {
		const html = element.html ?? "";
		if (!html.trim()) {
			errors.push(
				`New element ${element.id}: html elements need a non-empty "html" field.`,
			);
			return [];
		}
		return [
			{
				type: "insert_html_element",
				html,
				startTime,
				duration,
				...(trackId ? { trackId } : {}),
				...(element.name ? { name: element.name } : {}),
				...(element.w ? { sourceWidth: Math.round(element.w) } : {}),
				...(element.h ? { sourceHeight: Math.round(element.h) } : {}),
				...(element.params ? { params: element.params } : {}),
			},
		];
	}
	if (element.type === "graphic") {
		if (!element.graphic) {
			errors.push(
				`New element ${element.id}: graphic elements need a "graphic" definition id (rectangle, ellipse, polygon, star, preset-background).`,
			);
			return [];
		}
		return [
			{
				type: "insert_graphic_element",
				definitionId: element.graphic,
				startTime,
				duration,
				...(trackId ? { trackId } : {}),
				...(element.name ? { name: element.name } : {}),
				...(element.params ? { params: element.params } : {}),
			},
		];
	}
	if (
		element.type === "media" ||
		element.type === "video" ||
		element.type === "image" ||
		element.type === "audio"
	) {
		if (!element.media) {
			errors.push(
				`New element ${element.id}: media elements need a "media" asset id (see the media summary or timeline.list_media).`,
			);
			return [];
		}
		return [
			{
				type: "insert_media_element",
				mediaId: element.media,
				startTime,
				duration,
				...(trackId ? { trackId } : {}),
				...(element.name ? { name: element.name } : {}),
			},
		];
	}
	errors.push(
		`New element ${element.id}: unsupported type "${element.type}". Insertable types: text, html, graphic, media.`,
	);
	return [];
}
