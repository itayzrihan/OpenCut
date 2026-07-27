import type { MediaAsset } from "@/media/types";
import { getDisplayTracks as getTimelineDisplayTracks } from "@/timeline/track-order";
import type {
	Bookmark,
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline/types";
import type {
	AiElementSummary,
	AiLayerSummary,
	AiTimelineIndex,
	AiTimelineRange,
} from "./types";

const DEFAULT_TIMELINE_DOCUMENT_MAX_ELEMENTS = 220;
const DEFAULT_TIMELINE_DOCUMENT_TEXT_LIMIT = 90;

export function rangesOverlap({
	firstStart,
	firstEnd,
	secondStart,
	secondEnd,
}: {
	firstStart: number;
	firstEnd: number;
	secondStart: number;
	secondEnd: number;
}): boolean {
	return firstStart < secondEnd && firstEnd > secondStart;
}

export function elementOverlapsRange({
	element,
	range,
}: {
	element: Pick<TimelineElement, "startTime" | "duration">;
	range: AiTimelineRange;
}): boolean {
	return rangesOverlap({
		firstStart: element.startTime,
		firstEnd: element.startTime + element.duration,
		secondStart: range.startTime,
		secondEnd: range.endTime,
	});
}

export function getDisplayTracks(tracks: SceneTracks): TimelineTrack[] {
	return getTimelineDisplayTracks({ tracks });
}

export function buildTimelineContextIndex({
	tracks,
	mediaAssets = [],
}: {
	tracks: SceneTracks;
	mediaAssets?: MediaAsset[];
}): AiTimelineIndex {
	const assetsById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const displayTracks = getDisplayTracks(tracks);
	const layers: AiLayerSummary[] = [];
	const elements: AiElementSummary[] = [];

	for (const [index, track] of displayTracks.entries()) {
		const section =
			track.id === tracks.main.id
				? "main"
				: track.type === "audio"
					? "audio"
					: "overlay";
		layers.push({
			id: track.id,
			name: track.name,
			type: track.type,
			index,
			section,
			elementCount: track.elements.length,
			...("hidden" in track ? { hidden: track.hidden } : {}),
			...("muted" in track ? { muted: track.muted } : {}),
		});

		for (const element of track.elements) {
			const mediaId =
				element.type === "video" || element.type === "image"
					? element.mediaId
					: element.type === "audio" && element.sourceType === "upload"
						? element.mediaId
						: undefined;
			const mediaAsset = mediaId ? assetsById.get(mediaId) : undefined;
			const effects =
				"effects" in element && Array.isArray(element.effects)
					? element.effects.map((effect) => ({
							id: effect.id,
							type: effect.type,
							enabled: effect.enabled,
							params: summarizeParams(effect.params),
						}))
					: [];
			const masks =
				"masks" in element && Array.isArray(element.masks)
					? element.masks.map((mask) => ({
							id: mask.id,
							type: mask.type,
							...("inverted" in mask && typeof mask.inverted === "boolean"
								? { inverted: mask.inverted }
								: {}),
						}))
					: [];
			const keyframes = summarizeAnimations({
				animations: "animations" in element ? element.animations : undefined,
			});
			elements.push({
				trackId: track.id,
				elementId: element.id,
				name: element.name,
				type: element.type,
				startTime: element.startTime,
				endTime: element.startTime + element.duration,
				duration: element.duration,
				params: summarizeParams(element.params),
				...(mediaId ? { mediaId } : {}),
				...(element.type === "audio" && element.sourceType === "library"
					? { sourceUrl: element.sourceUrl }
					: {}),
				...(mediaAsset?.name ? { text: mediaAsset.name } : {}),
				...("text" in element.params && typeof element.params.text === "string"
					? { text: element.params.text }
					: {}),
				...("content" in element.params &&
				typeof element.params.content === "string"
					? { text: element.params.content }
					: {}),
				...(effects.length > 0 ? { effects } : {}),
				...(masks.length > 0 ? { masks } : {}),
				...(element.type === "video" && element.backgroundRemoval
					? { backgroundRemoval: element.backgroundRemoval }
					: {}),
				...(keyframes.length > 0 ? { keyframes } : {}),
				...("hidden" in element ? { hidden: element.hidden } : {}),
				...(element.type === "audio" && element.params.muted === true
					? { muted: true }
					: {}),
			});
		}
	}

	return {
		layers,
		elements,
		layersById: new Map(layers.map((layer) => [layer.id, layer])),
		elementsById: new Map(
			elements.map((element) => [
				`${element.trackId}:${element.elementId}`,
				element,
			]),
		),
	};
}

export function getElementsInRange({
	index,
	range,
}: {
	index: AiTimelineIndex;
	range: AiTimelineRange;
}): AiElementSummary[] {
	return index.elements
		.filter((element) =>
			rangesOverlap({
				firstStart: element.startTime,
				firstEnd: element.endTime,
				secondStart: range.startTime,
				secondEnd: range.endTime,
			}),
		)
		.sort(
			(a, b) => a.startTime - b.startTime || a.trackId.localeCompare(b.trackId),
		);
}

export function getLayersInRange({
	index,
	range,
}: {
	index: AiTimelineIndex;
	range: AiTimelineRange;
}): AiLayerSummary[] {
	const trackIds = new Set(
		getElementsInRange({ index, range }).map((element) => element.trackId),
	);
	return index.layers.filter((layer) => trackIds.has(layer.id));
}

export function searchLayers({
	index,
	query = "",
	types,
	cursor = 0,
	limit = 20,
}: {
	index: AiTimelineIndex;
	query?: string;
	types?: TrackType[];
	cursor?: number;
	limit?: number;
}): { items: AiLayerSummary[]; nextCursor: number | null } {
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = index.layers.filter((layer) => {
		const matchesType = !types || types.includes(layer.type);
		const matchesQuery =
			normalizedQuery.length === 0 ||
			layer.name.toLowerCase().includes(normalizedQuery) ||
			layer.id.toLowerCase().includes(normalizedQuery);
		return matchesType && matchesQuery;
	});
	return pageItems({ items: filtered, cursor, limit });
}

export function searchElements({
	index,
	query = "",
	trackId,
	type,
	range,
	cursor = 0,
	limit = 25,
}: {
	index: AiTimelineIndex;
	query?: string;
	trackId?: string;
	type?: string;
	range?: AiTimelineRange;
	cursor?: number;
	limit?: number;
}): { items: AiElementSummary[]; nextCursor: number | null } {
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = index.elements.filter((element) => {
		if (trackId && element.trackId !== trackId) return false;
		if (type && element.type !== type) return false;
		if (
			range &&
			!rangesOverlap({
				firstStart: element.startTime,
				firstEnd: element.endTime,
				secondStart: range.startTime,
				secondEnd: range.endTime,
			})
		) {
			return false;
		}
		if (normalizedQuery.length === 0) return true;
		return [
			element.name,
			element.elementId,
			element.trackId,
			element.text ?? "",
		]
			.join(" ")
			.toLowerCase()
			.includes(normalizedQuery);
	});
	return pageItems({ items: filtered, cursor, limit });
}

export function buildTimelineDocument({
	tracks,
	projectName,
	mediaAssets = [],
	range,
	selectedElements = [],
	currentTime,
	bookmarks = [],
	includeMediaSummary = false,
	includeCaptions = false,
	maxElements = DEFAULT_TIMELINE_DOCUMENT_MAX_ELEMENTS,
	maxTextLength = DEFAULT_TIMELINE_DOCUMENT_TEXT_LIMIT,
}: {
	tracks: SceneTracks;
	projectName?: string;
	mediaAssets?: MediaAsset[];
	range?: AiTimelineRange | null;
	selectedElements?: ElementRef[];
	currentTime?: number;
	bookmarks?: Bookmark[];
	includeMediaSummary?: boolean;
	includeCaptions?: boolean;
	maxElements?: number;
	maxTextLength?: number;
}): string {
	const index = buildTimelineContextIndex({ tracks, mediaAssets });
	const selectedKeys = new Set(
		selectedElements.map((element) =>
			elementKey({
				trackId: element.trackId,
				elementId: element.elementId,
			}),
		),
	);
	const rangeKeys = new Set(
		range
			? getElementsInRange({ index, range }).map((element) =>
					elementKey({
						trackId: element.trackId,
						elementId: element.elementId,
					}),
				)
			: [],
	);
	const prioritizedElements = prioritizeDocumentElements({
		elements: index.elements,
		selectedKeys,
		rangeKeys,
		limit: maxElements,
	});
	const document = {
		version: 1,
		format: "opencut_timeline_document",
		units: "media_ticks",
		project: projectName ? { name: projectName } : undefined,
		currentTime,
		activeRange: range
			? { startTime: range.startTime, endTime: range.endTime }
			: null,
		totals: {
			layers: index.layers.length,
			elements: index.elements.length,
			mediaAssets: mediaAssets.length,
			documentedElements: prioritizedElements.length,
			truncated: prioritizedElements.length < index.elements.length,
		},
		layers: index.layers.map((layer) => ({
			id: layer.id,
			name: layer.name,
			type: layer.type,
			section: layer.section,
			index: layer.index,
			elementCount: layer.elementCount,
			hidden: layer.hidden,
			muted: layer.muted,
		})),
		elements: prioritizedElements.map((element) => ({
			trackId: element.trackId,
			elementId: element.elementId,
			name: truncateText({ value: element.name, maxLength: maxTextLength }),
			type: element.type,
			startTime: element.startTime,
			endTime: element.endTime,
			duration: element.duration,
			mediaId: element.mediaId,
			sourceUrl: element.sourceUrl,
			text: element.text
				? truncateText({ value: element.text, maxLength: maxTextLength })
				: undefined,
			params: truncateParamStrings({
				params: element.params,
				maxTextLength,
			}),
			effects: element.effects?.map((effect) => ({
				...effect,
				params: truncateParamStrings({
					params: effect.params,
					maxTextLength,
				}),
			})),
			keyframes: element.keyframes,
			selected: selectedKeys.has(elementKey(element)) || undefined,
			inActiveRange: rangeKeys.has(elementKey(element)) || undefined,
			hidden: element.hidden,
			muted: element.muted,
		})),
		bookmarks: bookmarks.map((bookmark) => ({
			time: bookmark.time,
			duration: bookmark.duration,
			note: bookmark.note
				? truncateText({ value: bookmark.note, maxLength: maxTextLength })
				: undefined,
			color: bookmark.color,
		})),
		mediaAssets: includeMediaSummary
			? mediaAssets.map((asset) => ({
					id: asset.id,
					name: truncateText({ value: asset.name, maxLength: maxTextLength }),
					type: asset.type,
					duration: asset.duration,
					width: asset.width,
					height: asset.height,
				}))
			: undefined,
		captionTracks: includeCaptions
			? tracks.overlay.filter(isGeneratedCaptionTrack).map((track) => ({
					trackId: track.id,
					name: track.name,
					wordCount: track.captionSource.words.length,
					settings: track.captionSource.settings,
					layerIndex: track.captionSource.layerIndex,
					layerCount: track.captionSource.layerCount,
				}))
			: undefined,
		notes:
			prioritizedElements.length < index.elements.length
				? [
						"Timeline document is truncated. Use timeline.search_elements or timeline.get_layer for omitted elements.",
					]
				: [],
	};

	return JSON.stringify(document);
}

function pageItems<T>({
	items,
	cursor,
	limit,
}: {
	items: T[];
	cursor: number;
	limit: number;
}): { items: T[]; nextCursor: number | null } {
	const safeCursor = Math.max(0, cursor);
	const safeLimit = Math.max(1, Math.min(100, limit));
	const page = items.slice(safeCursor, safeCursor + safeLimit);
	const nextCursor =
		safeCursor + safeLimit < items.length ? safeCursor + safeLimit : null;
	return { items: page, nextCursor };
}

function summarizeParams(
	params: Record<string, unknown>,
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(params)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			result[key] = value;
		}
	}
	return result;
}

function summarizeAnimations({
	animations,
}: {
	animations: TimelineElement["animations"] | undefined;
}): NonNullable<AiElementSummary["keyframes"]> {
	if (!animations) {
		return [];
	}
	const keyframes: NonNullable<AiElementSummary["keyframes"]> = [];
	for (const [propertyPath, channelData] of Object.entries(animations)) {
		collectAnimationKeyframes({
			propertyPath,
			channelData,
			keyframes,
		});
	}
	return keyframes;
}

function collectAnimationKeyframes({
	propertyPath,
	channelData,
	componentKey,
	keyframes,
}: {
	propertyPath: string;
	channelData: unknown;
	componentKey?: string;
	keyframes: NonNullable<AiElementSummary["keyframes"]>;
}): void {
	if (!isRecord(channelData)) {
		return;
	}
	if (Array.isArray(channelData.keys)) {
		for (const keyframe of channelData.keys) {
			const summary = summarizeKeyframe({
				propertyPath,
				componentKey,
				keyframe,
			});
			if (summary) {
				keyframes.push(summary);
			}
		}
		return;
	}
	for (const [nestedComponentKey, nestedChannelData] of Object.entries(
		channelData,
	)) {
		collectAnimationKeyframes({
			propertyPath,
			componentKey: nestedComponentKey,
			channelData: nestedChannelData,
			keyframes,
		});
	}
}

function summarizeKeyframe({
	propertyPath,
	componentKey,
	keyframe,
}: {
	propertyPath: string;
	componentKey?: string;
	keyframe: unknown;
}): NonNullable<AiElementSummary["keyframes"]>[number] | null {
	if (!isRecord(keyframe)) {
		return null;
	}
	const keyframeId = typeof keyframe.id === "string" ? keyframe.id : "";
	const time = typeof keyframe.time === "number" ? keyframe.time : null;
	const value = keyframe.value;
	if (
		!keyframeId ||
		time === null ||
		(typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean")
	) {
		return null;
	}
	return {
		propertyPath,
		keyframeId,
		time,
		value,
		interpolation:
			typeof keyframe.segmentToNext === "string"
				? keyframe.segmentToNext
				: undefined,
		componentKey,
	};
}

function prioritizeDocumentElements({
	elements,
	selectedKeys,
	rangeKeys,
	limit,
}: {
	elements: AiElementSummary[];
	selectedKeys: Set<string>;
	rangeKeys: Set<string>;
	limit: number;
}): AiElementSummary[] {
	const safeLimit = Math.max(1, limit);
	const sorted = [...elements].sort((a, b) => {
		const aKey = elementKey(a);
		const bKey = elementKey(b);
		const aScore =
			Number(selectedKeys.has(aKey)) * 2 + Number(rangeKeys.has(aKey));
		const bScore =
			Number(selectedKeys.has(bKey)) * 2 + Number(rangeKeys.has(bKey));
		return (
			bScore - aScore ||
			a.startTime - b.startTime ||
			a.trackId.localeCompare(b.trackId) ||
			a.elementId.localeCompare(b.elementId)
		);
	});
	return sorted
		.slice(0, safeLimit)
		.sort(
			(a, b) => a.startTime - b.startTime || a.trackId.localeCompare(b.trackId),
		);
}

function elementKey({
	trackId,
	elementId,
}: {
	trackId: string;
	elementId: string;
}): string {
	return `${trackId}:${elementId}`;
}

function truncateParamStrings({
	params,
	maxTextLength,
}: {
	params: Record<string, string | number | boolean>;
	maxTextLength: number;
}): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(params).map(([key, value]) => [
			key,
			typeof value === "string"
				? truncateText({ value, maxLength: maxTextLength })
				: value,
		]),
	);
}

function truncateText({
	value,
	maxLength,
}: {
	value: string;
	maxLength: number;
}): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isGeneratedCaptionTrack(track: TimelineTrack): track is Extract<
	TimelineTrack,
	{ type: "text" }
> & {
	captionSource: NonNullable<
		Extract<TimelineTrack, { type: "text" }>["captionSource"]
	>;
} {
	return track.type === "text" && track.captionSource !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
