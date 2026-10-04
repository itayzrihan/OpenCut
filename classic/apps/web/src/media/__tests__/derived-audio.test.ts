/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Audio decoding is supplied by a deterministic platform test double. */
import { beforeAll, expect, mock, test } from "bun:test";
import type { AudioClipSource } from "../audio";
import type { SceneTracks } from "@/timeline";
import { mediaTime } from "@/wasm";

let collectAudioClips: typeof import("../audio").collectAudioClips;
let collectAudioElements: typeof import("../audio").collectAudioElements;
beforeAll(async () => {
	const glue = await import("../../../../../rust/wasm/pkg/opencut_wasm_bg.js");
	const bytes = await Bun.file(
		new URL(
			"../../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer();
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./opencut_wasm_bg.js": glue,
	});
	glue.__wbg_set_wasm(instance.exports);
	const start = instance.exports.__wbindgen_start;
	if (typeof start !== "function")
		throw new Error("Missing WASM startup export");
	start();
	mock.module("opencut-wasm", () => glue);
	({ collectAudioClips, collectAudioElements } = await import("../audio"));
});

test("derived compound audio joins native collection, decodes once across cuts and fails visibly on missing audio", async () => {
	const tracks: SceneTracks = {
		main: {
			id: "main",
			type: "video",
			name: "Main",
			elements: [],
			hidden: false,
			muted: false,
		},
		overlay: [],
		audio: [],
	};
	const clip: AudioClipSource = {
		id: "first",
		sourceKey: "compound",
		startTime: 8,
		duration: 2,
		trimStart: 1,
		trimEnd: 3,
		muted: false,
		volume: 1,
		mediaAsset: {
			id: "compound",
			name: "Narration",
			type: "audio",
			file: new File(["audio"], "mix.m4a"),
		},
		timelineElement: {
			id: "first",
			name: "Compound",
			type: "audio",
			sourceType: "upload",
			mediaId: "compound",
			startTime: mediaTime({ ticks: 960000 }),
			duration: mediaTime({ ticks: 240000 }),
			trimStart: mediaTime({ ticks: 120000 }),
			trimEnd: mediaTime({ ticks: 360000 }),
			params: {},
		},
	};
	const second = { ...clip, id: "second", startTime: 11, trimStart: 3 };
	const callbacks: AudioClipSource[][] = [];
	const collected = await collectAudioClips({
		tracks,
		mediaAssets: [],
		additionalClips: Promise.resolve([clip, second]),
		onClips: (clips) => callbacks.push(clips),
	});
	expect(callbacks).toEqual([[], [clip, second]]);
	expect(collected).toEqual([clip, second]);
	const buffer = {} as AudioBuffer;
	let decodes = 0;
	const decoded = await collectAudioElements({
		tracks,
		mediaAssets: [],
		additionalClips: collected,
		audioContext: {} as AudioContext,
		resolveAssetAudio: async () => {
			decodes++;
			return buffer;
		},
	});
	expect(decodes).toBe(1);
	expect(
		decoded.map(({ startTime, trimStart, duration }) => ({
			startTime,
			trimStart,
			duration,
		})),
	).toEqual([
		{ startTime: 8, trimStart: 1, duration: 2 },
		{ startTime: 11, trimStart: 3, duration: 2 },
	]);
	await expect(
		collectAudioElements({
			tracks,
			mediaAssets: [],
			additionalClips: [clip],
			audioContext: {} as AudioContext,
			resolveAssetAudio: async () => null,
		}),
	).rejects.toThrow("Could not decode");
	await expect(
		collectAudioClips({
			tracks,
			mediaAssets: [],
			additionalClips: Promise.reject(new Error("mixer failed")),
		}),
	).rejects.toThrow("mixer failed");
});
