/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal serializable library fixture exercises the actual collection path. */
import { wasm } from "../../../test-support/wasm";
import { expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
mock.module("opencut-wasm", () => ({
	...wasm,
	TICKS_PER_SECOND: 120000,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
}));
let fileReads = 0;
const urlReads: string[] = [];
mock.module("@/shared-library", () => ({
	sharedLibraryService: {
		getAudioAssetUrl: async ({ id }: { id: string }) => {
			urlReads.push(id);
			return `/api/global-assets/${id}.mp3`;
		},
		getAudioAssetFile: async () => {
			fileReads++;
			return new File(["audio"], "sound.mp3");
		},
	},
}));
const { collectAudioClips, collectAudioMixSources } = await import("../audio");
const tracks = {
	main: { id: "main", type: "video", elements: [] },
	overlay: [],
	audio: [
		{
			id: "sfx",
			type: "audio",
			elements: [
				{
					id: "opening",
					type: "audio",
					sourceType: "library",
					libraryAssetId: "swish",
					name: "Swish",
					startTime: 0,
					duration: 120000,
					trimStart: 0,
					trimEnd: 0,
					params: { volume: 1 },
				},
				{
					id: "late-song",
					type: "audio",
					sourceType: "library",
					libraryAssetId: "song",
					name: "Music",
					startTime: 120000 * 100,
					duration: 120000 * 180,
					trimStart: 0,
					trimEnd: 0,
					params: { volume: 0.2 },
				},
			],
		},
	],
} as unknown as SceneTracks;
test("Play resolves library URLs without downloading the music and SFX; export retains full files", async () => {
	const clips = await collectAudioClips({ tracks, mediaAssets: [] });
	expect(fileReads).toBe(0);
	expect(urlReads).toEqual(["swish", "song"]);
	expect(clips.map((c) => c.url)).toEqual([
		"/api/global-assets/swish.mp3",
		"/api/global-assets/song.mp3",
	]);
	expect(clips[1].startTime).toBe(100);
	expect(clips[1].duration).toBe(180);
	const exported = await collectAudioMixSources({ tracks, mediaAssets: [] });
	expect(fileReads).toBe(2);
	expect(exported.every((c) => c.file instanceof File)).toBe(true);
});
