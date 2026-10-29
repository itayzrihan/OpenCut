/* eslint-disable opencut/prefer-object-params, @typescript-eslint/no-unsafe-type-assertion -- Test doubles implement native positional Web Audio APIs and inspect the private playback boundary. */
import { expect, mock, test } from "bun:test";
import { wasm } from "../../../test-support/wasm";
import type { EarshotSpec } from "../types";
import type { SceneTracks } from "@/timeline";
import type { EditorCore } from "@/core";

mock.module("opencut-wasm", () => ({ ...wasm, TICKS_PER_SECOND: 120000 }));
let renders = 0;
mock.module("@/earshot/render", () => ({
	renderEarshotSound: async ({ spec }: { spec: EarshotSpec }) => {
		renders++;
		if (spec.sourceCode === "broken") throw new Error("Recipe failed");
		return {
			sampleRate: 48000,
			channels: [
				Float32Array.from(
					{ length: Math.round(spec.duration * 48000) },
					(_, i) => i / (spec.duration * 48000),
				),
			],
		};
	},
}));
mock.module("@/shared-library", () => ({
	sharedLibraryService: {
		getAudioAssetFile: () => {
			throw new Error("Code audio must not read files");
		},
		getAudioAssetUrl: () => {
			throw new Error("Code audio must not resolve URLs");
		},
	},
}));
function buffer(channels: number, length: number, sampleRate: number) {
	const data = Array.from({ length: channels }, () => new Float32Array(length));
	return {
		sampleRate,
		length,
		duration: length / sampleRate,
		numberOfChannels: channels,
		getChannelData: (i: number) => data[i],
		copyToChannel: (value: Float32Array, i: number, start = 0) =>
			data[i].set(value, start),
	} as AudioBuffer;
}
const context = { createBuffer: buffer, sampleRate: 48000 } as AudioContext;
const spec: EarshotSpec = {
	version: 1,
	engine: "earshot",
	bankRevision: "591fa3e028032e6dce56620a20e932e35667e8d8",
	presetId: "ui_pop/soft",
	seed: 42,
	duration: 4,
};
const element = {
	id: "code",
	type: "audio",
	sourceType: "procedural",
	procedural: spec,
	name: "Code pop",
	startTime: 120000,
	duration: 120000,
	trimStart: 120000,
	trimEnd: 240000,
	sourceDuration: 480000,
	params: { volume: 1 },
};
const tracks = {
	main: { id: "video", type: "video", elements: [] },
	overlay: [],
	audio: [{ id: "a", type: "audio", elements: [element], muted: false }],
} as unknown as SceneTracks;
const {
	collectAudioClips,
	collectAudioMixSources,
	collectAudioElements,
	timelineHasAudio,
} = await import("@/media/audio");
const { resolveEarshotBuffer, earshotSourceKey, sliceEarshotBuffer } =
	await import("../audio");

test("a durable code recipe is audible and collected without file or codec IO", async () => {
	expect(timelineHasAudio({ tracks, mediaAssets: [] })).toBe(true);
	const [clip] = await collectAudioClips({ tracks, mediaAssets: [] });
	expect(clip.procedural).toEqual(spec);
	expect([clip.file, clip.url, clip.mediaAsset]).toEqual([
		undefined,
		undefined,
		undefined,
	]);
	expect([clip.startTime, clip.duration, clip.trimStart, clip.trimEnd]).toEqual(
		[1, 1, 1, 2],
	);
	expect(
		(await collectAudioMixSources({ tracks, mediaAssets: [] }))[0].procedural,
	).toEqual(spec);
	const [collected] = await collectAudioElements({
		tracks,
		mediaAssets: [],
		audioContext: context,
	});
	expect(collected.buffer.duration).toBe(4);
	expect(collected.trimStart).toBe(1);
});

test("source-cache identity changes with editable code, parameters and seed; consumers cannot mutate the cache", async () => {
	const before = renders;
	const a = await resolveEarshotBuffer({
		spec: { ...spec, seed: 123 },
		context,
	});
	a.getChannelData(0)[1] = 99;
	const b = await resolveEarshotBuffer({
		spec: { ...spec, seed: 123 },
		context,
	});
	expect(renders - before).toBe(1);
	expect(b.getChannelData(0)[1]).toBeLessThan(1);
	expect(earshotSourceKey({ ...spec, parameters: { a: 1, b: 2 } })).toBe(
		earshotSourceKey({ ...spec, parameters: { b: 2, a: 1 } }),
	);
	for (const patch of [
		{ seed: 43 },
		{ pitch: 440 },
		{ sourceCode: "custom" },
		{ echo: { delay: 0.1, feedback: 0.2, mix: 0.3 } },
	])
		expect(earshotSourceKey({ ...spec, ...patch })).not.toBe(
			earshotSourceKey(spec),
		);
});

test("split and seek retain the original source clock rather than restarting the sound", async () => {
	const original = await resolveEarshotBuffer({ spec, context });
	const segment = sliceEarshotBuffer({
		buffer: original,
		context,
		start: 1.25,
		end: 2,
	});
	expect(segment.length).toBe(36000);
	expect(segment.getChannelData(0)[0]).toBeCloseTo(1.25 / 4, 6);
	expect(segment.getChannelData(0)[segment.length - 1]).toBeCloseTo(0.5, 4);
});

test("invalid code fails export preparation instead of producing a silent successful export", async () => {
	const broken = structuredClone(tracks);
	const clip = broken.audio[0].elements[0];
	if (clip.sourceType !== "procedural") throw Error("fixture");
	clip.procedural.sourceCode = "broken";
	await expect(
		collectAudioElements({
			tracks: broken,
			mediaAssets: [],
			audioContext: context,
		}),
	).rejects.toThrow("Recipe failed");
	const abort = new AbortController();
	abort.abort();
	await expect(
		resolveEarshotBuffer({ spec, context, signal: abort.signal }),
	).rejects.toThrow();
});

test("the actual playback manager bypasses demux and plays the trimmed procedural range", async () => {
	const { AudioManager } = await import("@/core/managers/audio-manager");
	const subscribe = () => () => {};
	const editor = {
		playback: {
			getVolume: () => 1,
			registerPlaybackPreparer: subscribe,
			subscribe,
			onSeek: subscribe,
		},
		timeline: { subscribe },
		scenes: { subscribe },
		media: { subscribe },
		project: { subscribe },
	} as unknown as EditorCore;
	const manager = new AudioManager(editor) as unknown as {
		audioContext: AudioContext;
		getAudioSink: () => never;
		decodeClipBuffer(input: {
			clip: Awaited<ReturnType<typeof collectAudioClips>>[number];
			sourceStart: number;
			sourceEnd: number;
		}): Promise<AudioBuffer>;
		shouldUsePreparedClipBuffer(input: {
			clip: Awaited<ReturnType<typeof collectAudioClips>>[number];
		}): boolean;
	};
	manager.audioContext = context;
	manager.getAudioSink = () => {
		throw new Error("No demux for code sources");
	};
	const [clip] = await collectAudioClips({ tracks, mediaAssets: [] });
	expect(
		manager.shouldUsePreparedClipBuffer({ clip: { ...clip, duration: 20 } }),
	).toBe(true);
	const decoded = await manager.decodeClipBuffer({
		clip,
		sourceStart: 1,
		sourceEnd: 2,
	});
	expect(decoded.duration).toBe(1);
	expect(decoded.getChannelData(0)[0]).toBeCloseTo(0.25, 6);
});
