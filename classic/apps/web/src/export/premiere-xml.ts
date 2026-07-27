import {
	generatePremiereXml,
	type FrameRate,
	type PremiereExportClip,
	type PremiereExportTrack,
} from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
import type { TCanvasSize } from "@/project/types";
import {
	calculateTotalDuration,
	getDisplayTracks,
	hasMediaId,
	type AudioTrack,
	type TScene,
	type VideoTrack,
} from "@/timeline";
import { downloadBlob } from "@/utils/browser";
import { mediaTimeToSeconds, type MediaTime } from "@/wasm";

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_DEPTH = 16;

function seconds(time: MediaTime): number {
	return mediaTimeToSeconds({ time });
}

function exportFileName(sceneName: string): string {
	const safeName = sceneName
		.replace(/[<>:"/\\|?*]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return `${safeName || "PoCut sequence"}_Premiere.xml`;
}

function buildClip({
	asset,
	name,
	startTime,
	duration,
	trimStart,
}: {
	asset: MediaAsset;
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
}): PremiereExportClip {
	if (!asset.sourcePath || asset.missing) {
		throw new Error(`${asset.name} is missing its local source path`);
	}
	return {
		sourceId: asset.id,
		name: asset.name || name,
		path: asset.sourcePath,
		sourceDurationSeconds:
			asset.duration ?? seconds(duration) + seconds(trimStart),
		timelineStartSeconds: seconds(startTime),
		timelineDurationSeconds: seconds(duration),
		sourceStartSeconds: seconds(trimStart),
		sourceHasAudio: asset.hasAudio === true,
	};
}

function buildVideoTrack({
	track,
	mediaById,
}: {
	track: VideoTrack;
	mediaById: Map<string, MediaAsset>;
}): PremiereExportTrack | null {
	const clips = track.elements.flatMap((element) => {
		if (element.type !== "video" || element.hidden || !hasMediaId(element)) {
			return [];
		}
		const asset = mediaById.get(element.mediaId);
		if (!asset) throw new Error(`${element.name} is missing from project media`);
		return [
			buildClip({
				asset,
				name: element.name,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
			}),
		];
	});
	return clips.length > 0 ? { name: track.name, clips } : null;
}

function buildAudioTrack({
	track,
	mediaById,
}: {
	track: AudioTrack;
	mediaById: Map<string, MediaAsset>;
}): PremiereExportTrack | null {
	if (track.muted) return null;
	const clips = track.elements.flatMap((element) => {
		if (
			element.sourceType !== "upload" ||
			element.params.muted === true ||
			!hasMediaId(element)
		) {
			return [];
		}
		const asset = mediaById.get(element.mediaId);
		if (!asset) throw new Error(`${element.name} is missing from project media`);
		return [
			buildClip({
				asset,
				name: element.name,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
			}),
		];
	});
	return clips.length > 0 ? { name: track.name, clips } : null;
}

export function buildPremiereXml({
	scene,
	mediaAssets,
	fps,
	canvasSize,
}: {
	scene: TScene;
	mediaAssets: MediaAsset[];
	fps: FrameRate;
	canvasSize: TCanvasSize;
}): string {
	const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const displayTracks = getDisplayTracks({ tracks: scene.tracks });
	const hasPodcastRouting = displayTracks.some(
		(track) => track.type === "video" && track.name.startsWith("Routed "),
	);
	const videoTracks = displayTracks.flatMap((track) => {
		if (track.type !== "video" || track.hidden) return [];
		if (hasPodcastRouting && !track.name.startsWith("Routed ")) return [];
		const exportTrack = buildVideoTrack({ track, mediaById });
		return exportTrack ? [exportTrack] : [];
	});
	const audioTracks = displayTracks.flatMap((track) => {
		if (track.type !== "audio") return [];
		const exportTrack = buildAudioTrack({ track, mediaById });
		return exportTrack ? [exportTrack] : [];
	});

	if (videoTracks.length === 0) {
		throw new Error("This sequence has no local video clips to export");
	}

	return generatePremiereXml({
		sequenceName: scene.name,
		fpsNumerator: fps.numerator,
		fpsDenominator: fps.denominator,
		width: canvasSize.width,
		height: canvasSize.height,
		durationSeconds: seconds(calculateTotalDuration({ tracks: scene.tracks })),
		videoTracks,
		audioTracks,
		audioSampleRate: AUDIO_SAMPLE_RATE,
		audioDepth: AUDIO_DEPTH,
	});
}

export function exportSceneToPremiereXml({
	scene,
	mediaAssets,
	fps,
	canvasSize,
}: {
	scene: TScene;
	mediaAssets: MediaAsset[];
	fps: FrameRate;
	canvasSize: TCanvasSize;
}): void {
	const xml = buildPremiereXml({ scene, mediaAssets, fps, canvasSize });
	downloadBlob({
		blob: new Blob([xml], { type: "application/xml;charset=utf-8" }),
		filename: exportFileName(scene.name),
	});
}
