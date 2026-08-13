import { PARALLAX_CAMERA_GUIDE_KIND, readParallaxSceneId } from "./model";
import type {
	ElementRef,
	AudioElement,
	EffectElement,
	GraphicElement,
	ImageElement,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
	StickerElement,
	TextElement,
	VideoElement,
} from "@/timeline/types";
import { getDisplayTracks } from "@/timeline/track-order";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";

export type InsertSelectionMode = "move" | "duplicate";

export interface InsertSelectionIntoCanvasResult {
	scenes: TScene[];
	parentElementRef: ElementRef;
	importedElementRefs: ElementRef[];
}

type SelectedSource = {
	track: TimelineTrack;
	element: TimelineElement;
};

export function insertSelectionIntoCanvas({
	scenes,
	parentSceneId,
	parallaxElementId,
	selectedElements,
	mode,
	createId = generateUUID,
}: {
	scenes: TScene[];
	parentSceneId: string;
	parallaxElementId: string;
	selectedElements: ElementRef[];
	mode: InsertSelectionMode;
	createId?: () => string;
}): InsertSelectionIntoCanvasResult | null {
	const parentScene = scenes.find((scene) => scene.id === parentSceneId);
	if (!parentScene) return null;
	const parentTracks = getDisplayTracks({ tracks: parentScene.tracks });
	const parentEntry = findElementEntry({
		tracks: parentTracks,
		elementId: parallaxElementId,
	});
	if (!parentEntry || parentEntry.element.type !== "effect") return null;
	const childSceneId = readParallaxSceneId({ params: parentEntry.element.params });
	const childScene = scenes.find((scene) => scene.id === childSceneId);
	if (!childScene?.parallax) return null;

	const selectedIds = new Set(
		selectedElements
			.filter((ref) => ref.elementId !== parallaxElementId)
			.map((ref) => `${ref.trackId}:${ref.elementId}`),
	);
	const selectedSources = parentTracks.flatMap((track) =>
		track.elements.flatMap((element) =>
			selectedIds.has(`${track.id}:${element.id}`)
				? [{ track, element } satisfies SelectedSource]
				: [],
		),
	);
	if (selectedSources.length === 0) return null;

	const oldStart = parentEntry.element.startTime;
	const oldEnd = addMediaTime({
		a: parentEntry.element.startTime,
		b: parentEntry.element.duration,
	});
	const selectedStart = selectedSources.reduce(
		(minimum, source) =>
			source.element.startTime < minimum ? source.element.startTime : minimum,
		oldStart,
	);
	const selectedEnd = selectedSources.reduce((maximum, source) => {
		const end = addMediaTime({
			a: source.element.startTime,
			b: source.element.duration,
		});
		return end > maximum ? end : maximum;
	}, oldEnd);
	const nextStart = selectedStart < oldStart ? selectedStart : oldStart;
	const nextEnd = selectedEnd > oldEnd ? selectedEnd : oldEnd;
	const nextDuration = subMediaTime({ a: nextEnd, b: nextStart });
	const childShift = subMediaTime({ a: oldStart, b: nextStart });

	const imported = buildImportedTracks({
		selectedSources,
		nextStart,
		mode,
		createId,
	});
	const movedElementIds = new Set(
		mode === "move" ? selectedSources.map(({ element }) => element.id) : [],
	);
	const nextParentTracks = updateParentTracks({
		tracks: parentScene.tracks,
		parallaxElementId,
		movedElementIds,
		nextStart,
		nextDuration,
	});
	const shiftedChildTracks = shiftChildTracks({
		tracks: childScene.tracks,
		shift: childShift,
		duration: nextDuration,
	});
	const nextChildTracks: SceneTracks = {
		...shiftedChildTracks,
		overlay: [...imported.overlay, ...shiftedChildTracks.overlay],
		audio: [...shiftedChildTracks.audio, ...imported.audio],
		order: [
			...imported.overlay.map((track) => track.id),
			...(shiftedChildTracks.order ?? []),
			...imported.audio.map((track) => track.id),
		],
	};
	const now = new Date();
	const nextScenes = scenes.map((scene) => {
		if (scene.id === parentScene.id) {
			return { ...scene, tracks: nextParentTracks, updatedAt: now };
		}
		if (scene.id === childScene.id) {
			return { ...scene, tracks: nextChildTracks, updatedAt: now };
		}
		return scene;
	});

	return {
		scenes: nextScenes,
		parentElementRef: {
			trackId: parentEntry.track.id,
			elementId: parallaxElementId,
		},
		importedElementRefs: imported.refs,
	};
}

function findElementEntry({
	tracks,
	elementId,
}: {
	tracks: TimelineTrack[];
	elementId: string;
}): SelectedSource | null {
	for (const track of tracks) {
		const element = track.elements.find((candidate) => candidate.id === elementId);
		if (element) return { track, element };
	}
	return null;
}

function updateParentTracks({
	tracks,
	parallaxElementId,
	movedElementIds,
	nextStart,
	nextDuration,
}: {
	tracks: SceneTracks;
	parallaxElementId: string;
	movedElementIds: Set<string>;
	nextStart: MediaTime;
	nextDuration: MediaTime;
}): SceneTracks {
	const updateTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack => ({
		...track,
		elements: track.elements.flatMap((element) => {
			if (movedElementIds.has(element.id)) return [];
			if (element.id !== parallaxElementId) return [element];
			return [
				{
					...element,
					startTime: nextStart,
					duration: nextDuration,
				},
			];
		}),
	}) as TTrack;
	return {
		...tracks,
		overlay: tracks.overlay.map(updateTrack),
		main: updateTrack(tracks.main),
		audio: tracks.audio.map(updateTrack),
	};
}

function shiftChildTracks({
	tracks,
	shift,
	duration,
}: {
	tracks: SceneTracks;
	shift: MediaTime;
	duration: MediaTime;
}): SceneTracks {
	const shiftTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack => ({
		...track,
		elements: track.elements.map((element) => {
			if (
				element.type === "effect" &&
				element.params.kind === PARALLAX_CAMERA_GUIDE_KIND
			) {
				return {
					...element,
					startTime: ZERO_MEDIA_TIME,
					duration,
				};
			}
			return {
				...element,
				startTime: addMediaTime({ a: element.startTime, b: shift }),
			};
		}),
	}) as TTrack;
	return {
		...tracks,
		overlay: tracks.overlay.map(shiftTrack),
		main: shiftTrack(tracks.main),
		audio: tracks.audio.map(shiftTrack),
	};
}

function buildImportedTracks({
	selectedSources,
	nextStart,
	mode,
	createId,
}: {
	selectedSources: SelectedSource[];
	nextStart: MediaTime;
	mode: InsertSelectionMode;
	createId: () => string;
}): {
	overlay: OverlayTrack[];
	audio: Extract<TimelineTrack, { type: "audio" }>[];
	refs: ElementRef[];
} {
	const byTrack = new Map<string, SelectedSource[]>();
	for (const source of selectedSources) {
		byTrack.set(source.track.id, [
			...(byTrack.get(source.track.id) ?? []),
			source,
		]);
	}
	const overlay: OverlayTrack[] = [];
	const audio: Extract<TimelineTrack, { type: "audio" }>[] = [];
	const refs: ElementRef[] = [];
	for (const sources of byTrack.values()) {
		const sourceTrack = sources[0]?.track;
		if (!sourceTrack) continue;
		const trackId = createId();
		const elements = sources.map(({ element }) => ({
			...element,
			id: mode === "duplicate" ? createId() : element.id,
			startTime: subMediaTime({ a: element.startTime, b: nextStart }),
		}));
		refs.push(...elements.map((element) => ({ trackId, elementId: element.id })));
		const name = `Canvas · ${sourceTrack.name}`;
		switch (sourceTrack.type) {
			case "audio":
				audio.push({
					...sourceTrack,
					id: trackId,
					name,
					elements: elements.filter(isAudioElement),
				});
				break;
			case "video":
				overlay.push({
					...sourceTrack,
					id: trackId,
					name,
					elements: elements.filter(isVideoTrackElement),
				});
				break;
			case "text":
				overlay.push({
					...sourceTrack,
					id: trackId,
					name,
					captionSource: undefined,
					elements: elements.filter(isTextElement),
				});
				break;
			case "graphic":
				overlay.push({
					...sourceTrack,
					id: trackId,
					name,
					elements: elements.filter(isGraphicTrackElement),
				});
				break;
			case "effect":
				overlay.push({
					...sourceTrack,
					id: trackId,
					name,
					elements: elements.filter(isEffectElement),
				});
				break;
		}
	}
	return { overlay, audio, refs };
}

function isAudioElement(element: TimelineElement): element is AudioElement {
	return element.type === "audio";
}

function isVideoTrackElement(
	element: TimelineElement,
): element is VideoElement | ImageElement {
	return element.type === "video" || element.type === "image";
}

function isTextElement(element: TimelineElement): element is TextElement {
	return element.type === "text";
}

function isGraphicTrackElement(
	element: TimelineElement,
): element is StickerElement | GraphicElement {
	return element.type === "sticker" || element.type === "graphic";
}

function isEffectElement(element: TimelineElement): element is EffectElement {
	return element.type === "effect";
}
