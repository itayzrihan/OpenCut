/* eslint-disable opencut/prefer-object-params -- Test doubles implement positional Web Audio and Mediabunny APIs. */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser audio nodes are deterministic test doubles; exercise the real manager and retiming code. */
import { expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { AudioClipSource } from "@/media/audio";
import { TICKS_PER_SECOND } from "@/wasm";

const ranges: number[][] = [];
const starts: number[][] = [];
const buffer = (channels: number, length: number, sampleRate: number) => {
	const data = Array.from({ length: channels }, () =>
		new Float32Array(length).fill(0.25),
	);
	return {
		sampleRate,
		length,
		duration: length / sampleRate,
		numberOfChannels: channels,
		getChannelData: (channel: number) => data[channel],
		copyToChannel: (value: Float32Array, channel: number) =>
			data[channel].set(value),
	} as AudioBuffer;
};
const gain = () => ({
	connect() {},
	disconnect() {},
	gain: {
		value: 1,
		cancelScheduledValues() {},
		setValueAtTime() {},
		linearRampToValueAtTime() {},
	},
});
const context = {
	sampleRate: 48000,
	state: "running",
	currentTime: 10,
	destination: {},
	createBuffer: buffer,
	createGain: gain,
	createBufferSource: () => ({
		buffer: null,
		connect() {},
		disconnect() {},
		addEventListener() {},
		start: (...args: number[]) => starts.push(args),
	}),
};
mock.module("@/media/audio", () => ({
	createAudioContext: () => context,
	collectAudioClips: async () => [],
	resolveAudioBufferForAsset: async () => null,
}));
mock.module("@/media/audio-mastering", () => ({
	createAudioMasteringChain: () => ({ input: gain() }),
}));
mock.module("@/media/audio-sink-cache", () => ({
	AudioSinkCache: class {
		canReadIndependentRanges() {
			return true;
		}
		clear() {}
		async get() {
			return {
				async *buffers(start: number, end: number) {
					ranges.push([start, end]);
					yield {
						buffer: buffer(2, Math.round((end - start) * 48000), 48000),
						timestamp: start,
					};
				},
			};
		}
	},
}));
const { AudioManager } = await import("../audio-manager");
const noopSubscribe = () => () => {};
const editor = {
	playback: {
		getVolume: () => 1,
		registerPlaybackPreparer: noopSubscribe,
		subscribe: noopSubscribe,
		onSeek: noopSubscribe,
		getIsPlaying: () => true,
		getClockTime: () => 54.2 * TICKS_PER_SECOND,
	},
	timeline: { subscribe: noopSubscribe },
	scenes: { subscribe: noopSubscribe },
	media: { subscribe: noopSubscribe },
	project: { subscribe: noopSubscribe },
} as unknown as EditorCore;
const clip = {
	id: "speech",
	sourceKey: "source",
	startTime: 50,
	duration: 8.5,
	trimStart: 100,
	trimEnd: 0,
	volume: 1,
	muted: false,
	timelineElement: { params: {} },
} as AudioClipSource;
function manager() {
	const manager = new AudioManager(editor);
	return manager as unknown as {
		audioContext: typeof context;
		audioClipsReady: boolean;
		clips: AudioClipSource[];
		preparePlayback(input: {
			time: number;
			lookaheadSeconds: number;
			signal: AbortSignal;
		}): Promise<void>;
		getPreparedWindow(input: {
			clip: AudioClipSource;
			time: number;
		}): AudioClipSource;
		schedulePreparedWindow(input: {
			clip: AudioClipSource;
			automationClip: AudioClipSource;
			startTime: number;
			sessionId: number;
		}): Promise<boolean>;
	};
}
test("Play decodes only the current bounded window, reuses it, and skips distant clips", async () => {
	ranges.length = 0;
	const m = manager();
	m.audioContext = context;
	m.audioClipsReady = true;
	m.clips = [clip, { ...clip, id: "later", startTime: 90 }];
	const input = {
		time: 54.2 * TICKS_PER_SECOND,
		lookaheadSeconds: 3,
		signal: new AbortController().signal,
	};
	await m.preparePlayback(input);
	await m.preparePlayback(input);
	expect(ranges).toEqual([[104, 106]]);
});
test("adjacent prepared windows schedule without overlap and stop at the cut", async () => {
	starts.length = 0;
	const m = manager();
	m.audioContext = context;
	for (const time of [54.2, 56, 58]) {
		await m.schedulePreparedWindow({
			clip: m.getPreparedWindow({ clip, time }),
			automationClip: clip,
			startTime: time,
			sessionId: 0,
		});
	}
	expect(starts).toHaveLength(3);
	expect(starts[0][1]).toBeCloseTo(0.2, 7);
	for (let i = 0; i < 2; i++)
		expect(starts[i][0] + starts[i][2]).toBeCloseTo(starts[i + 1][0], 7);
	expect(starts[2][2]).toBeCloseTo(0.5, 7);
});
test("retiming, pitch and audio sync retain the existing complete-buffer path", () => {
	const m = manager();
	for (const original of [
		{ ...clip, retime: { rate: 1.25, maintainPitch: true } },
		{
			...clip,
			timelineElement: {
				...clip.timelineElement,
				params: { audioSyncOffset: 0.1 },
			},
		},
	]) {
		expect(m.getPreparedWindow({ clip: original, time: 54.2 })).toBe(original);
	}
});

test("starting next to a window boundary prepares both sides before Play", async () => {
	ranges.length = 0;
	const m = manager();
	m.audioContext = context;
	m.audioClipsReady = true;
	m.clips = [clip];
	await m.preparePlayback({
		time: 55.95 * TICKS_PER_SECOND,
		lookaheadSeconds: 3,
		signal: new AbortController().signal,
	});
	expect(ranges).toEqual([
		[104, 106],
		[106, 108],
	]);
});
test("fractional clip starts advance to the next window without repetition", () => {
	const m = manager();
	const fractional = { ...clip, startTime: 50.123 };
	const first = m.getPreparedWindow({
		clip: fractional,
		time: fractional.startTime,
	});
	const second = m.getPreparedWindow({
		clip: fractional,
		time: first.startTime + first.duration,
	});
	expect(second.trimStart).toBe(first.trimStart + 2);
});
