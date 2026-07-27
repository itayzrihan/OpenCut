import type {
	PodcastSyncChannel,
	PodcastSyncResult,
} from "@/podcast-sync/engine";
import type {
	CreateTimelineElement,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
	VideoElement,
} from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { buildEmptyTrack } from "@/timeline/placement";
import { buildDefaultScene } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import {
	mediaTimeFromSeconds,
	roundMediaTime,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

function secondsToMediaTime({ seconds }: { seconds: number }): MediaTime {
	return mediaTimeFromSeconds({ seconds: Math.max(0, seconds) });
}

function sourceTrimEnd({
	sourceDurationSeconds,
	sourceStartSeconds,
	durationSeconds,
}: {
	sourceDurationSeconds: number;
	sourceStartSeconds: number;
	durationSeconds: number;
}): MediaTime {
	return secondsToMediaTime({
		seconds: Math.max(
			0,
			sourceDurationSeconds - sourceStartSeconds - durationSeconds,
		),
	});
}

function createTimelineElement<TElement extends CreateTimelineElement>(
	element: TElement,
): TElement & { id: string } {
	return {
		...element,
		id: generateUUID(),
	};
}

function createVideoSegment({
	channel,
	timelineStartSeconds,
	sourceStartSeconds,
	durationSeconds,
	keepCameraMic,
}: {
	channel: PodcastSyncChannel;
	timelineStartSeconds: number;
	sourceStartSeconds: number;
	durationSeconds: number;
	keepCameraMic: boolean;
}): VideoElement | null {
	const sourceDurationSeconds = channel.video.duration ?? 0;
	const safeDurationSeconds = Math.min(
		durationSeconds,
		Math.max(0, sourceDurationSeconds - sourceStartSeconds),
	);
	if (!(safeDurationSeconds > 0)) return null;

	const element = buildElementFromMedia({
		mediaId: channel.video.id,
		mediaType: "video",
		name: channel.video.name,
		duration: secondsToMediaTime({ seconds: safeDurationSeconds }),
		startTime: secondsToMediaTime({ seconds: timelineStartSeconds }),
	});
	if (element.type !== "video") return null;

	return {
		...createTimelineElement(element),
		trimStart: secondsToMediaTime({ seconds: sourceStartSeconds }),
		trimEnd: sourceTrimEnd({
			sourceDurationSeconds,
			sourceStartSeconds,
			durationSeconds: safeDurationSeconds,
		}),
		sourceDuration: secondsToMediaTime({ seconds: sourceDurationSeconds }),
		isSourceAudioEnabled: keepCameraMic,
	};
}

function createAudioSegment({
	channel,
	timelineStartSeconds,
	sourceStartSeconds,
	durationSeconds,
}: {
	channel: PodcastSyncChannel;
	timelineStartSeconds: number;
	sourceStartSeconds: number;
	durationSeconds: number;
}): TimelineElement | null {
	const sourceDurationSeconds = channel.audio.duration ?? 0;
	const safeDurationSeconds = Math.min(
		durationSeconds,
		Math.max(0, sourceDurationSeconds - sourceStartSeconds),
	);
	if (!(safeDurationSeconds > 0)) return null;

	const element = buildElementFromMedia({
		mediaId: channel.audio.id,
		mediaType: channel.audio.type,
		name: channel.audio.name,
		duration: secondsToMediaTime({ seconds: safeDurationSeconds }),
		startTime: secondsToMediaTime({ seconds: timelineStartSeconds }),
	});

	return {
		...createTimelineElement(element),
		trimStart: secondsToMediaTime({ seconds: sourceStartSeconds }),
		trimEnd: sourceTrimEnd({
			sourceDurationSeconds,
			sourceStartSeconds,
			durationSeconds: safeDurationSeconds,
		}),
		sourceDuration: secondsToMediaTime({ seconds: sourceDurationSeconds }),
	};
}

export function buildPodcastSyncScene({
	name,
	channels,
	result,
	keepCameraMics = false,
}: {
	name: string;
	channels: PodcastSyncChannel[];
	result: PodcastSyncResult;
	keepCameraMics?: boolean;
}): TScene {
	const scene = buildDefaultScene({ name, isMain: false });
	const routedTracks = channels.map((channel, index) =>
		buildEmptyTrack({
			id: generateUUID(),
			type: "video",
			name: `Routed ${index + 1} - ${channel.name}`,
		}),
	);
	const leftoverTracks = channels.map((channel, index) =>
		buildEmptyTrack({
			id: generateUUID(),
			type: "video",
			name: `Leftover ${index + 1} - ${channel.name}`,
		}),
	);
	const audioTracks = channels.map((channel, index) =>
		buildEmptyTrack({
			id: generateUUID(),
			type: "audio",
			name: `Podcast audio ${index + 1} - ${channel.name}`,
		}),
	);

	for (const cut of result.cuts) {
		for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
			const channel = channels[channelIndex]!;
			const targetTrack =
				channel.id === cut.channelId
					? routedTracks[channelIndex]!
					: leftoverTracks[channelIndex]!;
			const segment = createVideoSegment({
				channel,
				timelineStartSeconds: cut.timestamp,
				sourceStartSeconds:
					(result.videoOffsets[channel.id] ?? 0) + cut.timestamp,
				durationSeconds: cut.duration,
				keepCameraMic: keepCameraMics,
			});
			if (segment) targetTrack.elements.push(segment);
		}
	}

	for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
		const channel = channels[channelIndex]!;
		const audioDelay = result.audioDelays[channel.id] ?? 0;
		const audioOffset = result.audioOffsets[channel.id] ?? 0;
		const audioDuration = Math.max(0, result.duration - audioDelay);
		const element = createAudioSegment({
			channel,
			timelineStartSeconds: audioDelay,
			sourceStartSeconds: audioOffset,
			durationSeconds: audioDuration,
		});
		if (element?.type === "audio") {
			audioTracks[channelIndex]!.elements.push(element);
		} else if (element?.type === "video") {
			// If the user routes from camera audio, keep that audio source on an
			// audio-capable upload element instead of adding duplicate video.
			const audioElement = buildElementFromMedia({
				mediaId: channel.audio.id,
				mediaType: "audio",
				name: `${channel.audio.name} audio`,
				duration: element.duration,
				startTime: element.startTime,
			});
			if (audioElement.type === "audio") {
				audioTracks[channelIndex]!.elements.push({
					...createTimelineElement(audioElement),
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					sourceDuration: element.sourceDuration,
				});
			}
		}
	}

	return {
		...scene,
		tracks: {
			overlay: [...routedTracks, ...leftoverTracks],
			main: scene.tracks.main,
			audio: audioTracks,
		},
		updatedAt: new Date(),
	};
}

function cloneElementWithOffset({
	element,
	offset,
}: {
	element: TimelineElement;
	offset: MediaTime;
}): TimelineElement {
	return {
		...element,
		id: generateUUID(),
		startTime: roundMediaTime({ time: element.startTime + offset }),
	};
}

function cloneTrackWithOffset<TTrack extends TimelineTrack>({
	track,
	offset,
}: {
	track: TTrack;
	offset: MediaTime;
}): TTrack {
	return {
		...track,
		id: generateUUID(),
		elements: track.elements.map((element) =>
			cloneElementWithOffset({ element, offset }),
		),
	} as TTrack;
}

function mainTrackAsOverlay({
	source,
	offset,
}: {
	source: TScene;
	offset: MediaTime;
}): OverlayTrack[] {
	if (source.tracks.main.elements.length === 0) return [];
	return [
		{
			...cloneTrackWithOffset({ track: source.tracks.main, offset }),
			name: `${source.name} main`,
		},
	];
}

export function unnestSceneTracks({
	targetTracks,
	sourceScene,
	startTime,
}: {
	targetTracks: SceneTracks;
	sourceScene: TScene;
	startTime: MediaTime;
}): SceneTracks {
	const offset = startTime ?? ZERO_MEDIA_TIME;
	const sourceOverlays = [
		...sourceScene.tracks.overlay.map((track) =>
			cloneTrackWithOffset({ track, offset }),
		),
		...mainTrackAsOverlay({ source: sourceScene, offset }),
	];
	const sourceAudio = sourceScene.tracks.audio.map((track) =>
		cloneTrackWithOffset({ track, offset }),
	);

	return {
		...targetTracks,
		overlay: [...sourceOverlays, ...targetTracks.overlay],
		audio: [...targetTracks.audio, ...sourceAudio],
	};
}
