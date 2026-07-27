import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import { buildSubtitleTextElement } from "./build-subtitle-text-element";
import type { SubtitleCue } from "./types";
import type { TextTrack } from "@/timeline";
import {
	splitCaptionCuesByLayer,
	type CaptionLayoutSettings,
} from "./caption-layout";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";

export function buildCaptionTextTracks({
	captions,
	captionSource,
	settings,
	layerCount = 1,
	canvasSize,
	name = "Captions",
}: {
	captions: SubtitleCue[];
	captionSource?: TextTrack["captionSource"];
	settings?: CaptionLayoutSettings;
	layerCount?: number;
	canvasSize: { width: number; height: number };
	name?: string;
}): TextTrack[] {
	const layers = splitCaptionCuesByLayer({ captions, layerCount });
	const layoutSettings = captionSource?.settings ?? settings;
	const captionSourceId = captionSource
		? (captionSource.sourceId ?? generateUUID())
		: undefined;

	return layers.map((layerCaptions, layerIndex) => {
		const track = buildEmptyTrack({
			id: generateUUID(),
			type: "text",
			name: layers.length > 1 ? `${name} ${layerIndex + 1}` : name,
		});
		return {
			...track,
			elements: layerCaptions.map((caption, index) => ({
				...buildSubtitleTextElement({
					index,
					caption,
					canvasSize,
					revealMode: captionSource?.settings.revealMode,
					transitionIn: captionSource?.settings.transitionIn,
					wordAnimationId: captionSource?.settings.wordAnimationId,
					accentColor: captionSource?.settings.accentColor,
					wordDirection: captionSource?.settings.wordDirection,
					layoutSettings,
				}),
				id: generateUUID(),
			})),
			captionSource: captionSource
				? {
						...captionSource,
						sourceId: captionSourceId,
						layerIndex,
						layerCount: layers.length,
					}
				: undefined,
		};
	});
}

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
	captionSource,
	settings,
	layerCount = 1,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
	captionSource?: TextTrack["captionSource"];
	settings?: CaptionLayoutSettings;
	layerCount?: number;
}): string[] {
	if (captions.length === 0) {
		return [];
	}

	const canvasSize = editor.project.getActive().settings.canvasSize;
	const activeScene = editor.scenes.getActiveScene();
	const before = activeScene.tracks;
	const captionTracks = buildCaptionTextTracks({
		captions,
		captionSource,
		settings,
		layerCount,
		canvasSize,
	});
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before,
			after: {
				...before,
				overlay: [...captionTracks, ...before.overlay],
			},
		}),
	});

	return captionTracks.map((track) => track.id);
}
