import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { createUnifiedAnglesAsset } from "@/media/unified-angles";
import type { SceneTracks } from "@/timeline";
import type { MediaTime } from "@/wasm";

mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: 120_000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	formatTimecode: () => "00:00:00:00",
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => options,
	fitTextLayerWordsToSpan: () => [],
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	reconcileTextContentWords: () => [],
	normalizeTextLayerWordIds: () => [],
}));

let collectAudioClips: typeof import("@/media/audio").collectAudioClips;
let collectAudioElements: typeof import("@/media/audio").collectAudioElements;
let collectAudioMixSources: typeof import("@/media/audio").collectAudioMixSources;

beforeAll(async () => {
	({ collectAudioClips, collectAudioElements, collectAudioMixSources } =
		await import("@/media/audio"));
});

function mediaTime(seconds: number): MediaTime {
	return Math.round(seconds * 120_000) as MediaTime;
}

function video({ id }: { id: string }): MediaAsset {
	return {
		id,
		name: `Camera ${id}`,
		type: "video",
		size: 100,
		lastModified: 1,
		duration: 30,
		width: 1920,
		height: 1080,
		fps: 30,
		hasAudio: true,
		url: `blob:${id}`,
	};
}

describe("Unified Angles audio consumers", () => {
	test("resolve concrete audio for cut/transcription, playback, export, and extracted audio", async () => {
		const first = video({ id: "one" });
		const second = video({ id: "two" });
		const virtual: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: [first, second] }),
		};
		const duration = mediaTime(5);
		const zero = mediaTime(0);
		const common = {
			name: "Unified interview",
			startTime: zero,
			duration,
			trimStart: zero,
			trimEnd: zero,
			params: { volume: 1, muted: false },
		};
		const tracks: SceneTracks = {
			overlay: [],
			main: {
				id: "video-track",
				name: "Video",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					{
						...common,
						id: "video-element",
						type: "video",
						mediaId: virtual.id,
					},
				],
			},
			audio: [
				{
					id: "audio-track",
					name: "Extracted audio",
					type: "audio",
					muted: false,
					elements: [
						{
							...common,
							id: "audio-element",
							type: "audio",
							sourceType: "upload",
							mediaId: virtual.id,
						},
					],
				},
			],
			order: ["video-track", "audio-track"],
		};
		const mediaAssets = [first, second, virtual];

		const sources = await collectAudioMixSources({ tracks, mediaAssets });
		const clips = await collectAudioClips({ tracks, mediaAssets });
		const decodedAssetIds: string[] = [];
		const decodedElements = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext: {} as AudioContext,
			resolveAssetAudio: async ({ asset }) => {
				decodedAssetIds.push(asset.id);
				return {} as AudioBuffer;
			},
		});

		expect(sources).toHaveLength(2);
		expect(sources.every((source) => source.url === first.url)).toBe(true);
		expect(clips.map((clip) => clip.sourceKey)).toEqual(["one", "one"]);
		expect(clips.every((clip) => clip.url === first.url)).toBe(true);
		expect(decodedElements).toHaveLength(2);
		expect(decodedAssetIds).toEqual(["one"]);
	});
});
