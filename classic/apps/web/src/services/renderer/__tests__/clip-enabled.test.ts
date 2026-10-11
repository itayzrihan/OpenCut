import { expect, mock, test } from "bun:test";
import { wasm } from "../../../../test-support/wasm";
import type { SceneTracks, VideoElement } from "@/timeline/types";
import type { MediaAsset } from "@/media/types";
import type { MediaTime } from "@/wasm";
mock.module("opencut-wasm", () => wasm);
const { buildScene } = await import("../scene-builder");
const { collectAudioClips, collectAudioMixSources, collectAudioElements } =
	await import("@/media/audio");

function fixture() {
	const clip: VideoElement = {
		id: "camera",
		name: "Camera",
		type: "video",
		mediaId: "video",
		startTime: 0 as MediaTime,
		duration: 120000 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params: { volume: 0 },
		isSourceAudioEnabled: true,
	};
	const tracks: SceneTracks = {
		overlay: [],
		audio: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			hidden: false,
			muted: false,
			elements: [clip],
		},
	};
	const mediaAssets: MediaAsset[] = [
		{
			id: "video",
			type: "video",
			name: "Camera",
			size: 1,
			lastModified: 1,
			duration: 1,
			width: 1920,
			height: 1080,
			hasAudio: true,
			url: "blob:camera",
		},
	];
	return { clip, tracks, mediaAssets };
}

test("disabled clips bypass preview/export nodes and audio; enabling restores sources", async () => {
	const { clip, tracks, mediaAssets } = fixture();
	for (const enabled of [undefined, false, true]) {
		clip.enabled = enabled;
		for (const isPreview of [true, false]) {
			const root = buildScene({
				tracks,
				mediaAssets,
				canvasSize: { width: 1920, height: 1080 },
				duration: 120000 as MediaTime,
				background: { type: "color", color: "#000000" },
				isPreview,
			});
			expect(
				root.children.filter((node) => node.constructor.name === "VideoNode")
					.length,
			).toBe(enabled === false ? 0 : 1);
		}
		expect(await collectAudioClips({ tracks, mediaAssets })).toHaveLength(
			enabled === false ? 0 : 1,
		);
		expect(await collectAudioMixSources({ tracks, mediaAssets })).toHaveLength(
			enabled === false ? 0 : 1,
		);
		let decodes = 0;
		expect(
			await collectAudioElements({
				tracks,
				mediaAssets,
				audioContext: {} as AudioContext,
				resolveAssetAudio: async () => {
					decodes++;
					return {} as AudioBuffer;
				},
			}),
		).toHaveLength(enabled === false ? 0 : 1);
		expect(decodes).toBe(enabled === false ? 0 : 1);
	}
});
