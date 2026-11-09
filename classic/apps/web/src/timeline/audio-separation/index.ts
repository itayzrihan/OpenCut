import type { MediaAsset } from "@/media/types";
import type {
	TimelineElement,
	AudioElement,
	VideoElement,
	SceneTracks,
} from "../types";

type ElementRef = { trackId: string; elementId: string };

export function linkedAudioVideoPeer({
	tracks,
	element,
}: {
	tracks: SceneTracks;
	element: TimelineElement;
}) {
	if (
		!element.linkedAudioVideoId ||
		(element.type !== "video" && element.type !== "audio")
	)
		return;
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		const peer = track.elements.find(
			(clip) => clip.id === element.linkedAudioVideoId,
		);
		if (
			peer?.linkedAudioVideoId === element.id &&
			peer.type === (element.type === "video" ? "audio" : "video")
		)
			return { trackId: track.id, elementId: peer.id };
	}
}

export function includeLinkedAudioVideo({
	tracks,
	elements,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
}): ElementRef[] {
	const expanded = [...elements];
	for (const { trackId, elementId } of elements) {
		const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
			(entry) => entry.id === trackId,
		);
		const element = track?.elements.find((clip) => clip.id === elementId);
		const peer = element && linkedAudioVideoPeer({ tracks, element });
		if (peer && !expanded.some((ref) => ref.elementId === peer.elementId))
			expanded.push(peer);
	}
	return expanded;
}

type MediaAudioState = Pick<MediaAsset, "hasAudio">;

export function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return element.isSourceAudioEnabled !== false;
}

export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return !isSourceAudioEnabled({ element });
}

export function canExtractSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		element.type === "video" &&
		isSourceAudioEnabled({ element }) &&
		!!mediaAsset &&
		mediaAsset.hasAudio !== false
	);
}

export function canRecoverSourceAudio(
	element: TimelineElement,
): element is VideoElement {
	return element.type === "video" && isSourceAudioSeparated({ element });
}

export function canToggleSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		canRecoverSourceAudio(element) || canExtractSourceAudio(element, mediaAsset)
	);
}

export function doesElementHaveEnabledAudio({
	element,
	mediaAsset,
}: {
	element: AudioElement | VideoElement;
	mediaAsset?: MediaAudioState | null;
}): boolean {
	if (element.enabled === false) return false;
	if (element.type === "audio") {
		return true;
	}

	return (
		!!mediaAsset &&
		mediaAsset.hasAudio !== false &&
		isSourceAudioEnabled({ element })
	);
}

export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Separate audio from video" | "Recover audio" {
	return isSourceAudioSeparated({ element })
		? "Recover audio"
		: "Separate audio from video";
}
