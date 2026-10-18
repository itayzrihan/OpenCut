/* eslint-disable @typescript-eslint/no-explicit-any, opencut/prefer-object-params -- Web Audio host doubles. */
import { afterEach, expect, mock, test } from "bun:test";
let gap = false,
	disposed = 0;
const original = globalThis.OfflineAudioContext;
class Context {
	constructor(
		_channels: number,
		readonly length: number,
		readonly rate: number,
	) {}
	destination = {};
	createBuffer(_channels: number, length: number) {
		const samples = new Float32Array(length);
		return { getChannelData: () => samples };
	}
	createBufferSource() {
		return { connect() {}, disconnect() {}, start() {}, buffer: null };
	}
	async startRendering() {
		return this.createBuffer(1, this.length);
	}
}
mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	Input: class {
		async getPrimaryAudioTrack() {
			return { sampleRate: 44100, computeDuration: async () => 10800 };
		}
		dispose() {
			disposed++;
		}
	},
	AudioBufferSink: class {
		async *buffers() {
			for (const start of [0, gap ? 2048 : 1024])
				yield {
					timestamp: start / 44100,
					buffer: {
						length: 1024,
						numberOfChannels: 1,
						sampleRate: 44100,
						getChannelData: () => new Float32Array(1024),
					},
				};
		}
	},
}));
mock.module("../source", () => ({ createMediaSource: () => ({}) }));
const { openAudioWindowReader } = await import("../audio-window");
afterEach(() => {
	globalThis.OfflineAudioContext = original;
});
function context() {
	globalThis.OfflineAudioContext = Context as any;
	disposed = 0;
}
test("fractional resampling boundaries do not invent gaps between contiguous decoder packets", async () => {
	context();
	gap = false;
	const reader = await openAudioWindowReader({
		asset: { url: "local" },
		signal: new AbortController().signal,
	});
	const samples = await reader.read({
		start: 0,
		end: 2048 / 44100,
		missing: "unknown",
	});
	expect([...samples].every(Number.isFinite)).toBe(true);
	reader.close();
	expect(disposed).toBe(1);
});
test("actual missing decoder packets stay unknown instead of silent", async () => {
	context();
	gap = true;
	const reader = await openAudioWindowReader({
		asset: { url: "local" },
		signal: new AbortController().signal,
	});
	const samples = await reader.read({
		start: 0,
		end: 3072 / 44100,
		missing: "unknown",
	});
	expect(Number.isNaN(samples[500])).toBe(true);
	expect(Number.isFinite(samples[100])).toBe(true);
	expect(Number.isFinite(samples[900])).toBe(true);
	await expect(reader.read({ start: 0, end: 10800 })).rejects.toThrow(
		"at most 90 seconds",
	);
	reader.close();
});
