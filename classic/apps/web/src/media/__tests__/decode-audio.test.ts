import { beforeEach, expect, mock, test } from "bun:test";

type Chunk = {
	buffer: {
		length: number;
		sampleRate: number;
		duration: number;
		numberOfChannels: number;
		getChannelData: (index: number) => Float32Array;
	};
	timestamp: number;
};
let chunks: Chunk[] = [];
let disposed = false;
mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	Input: class {
		async getPrimaryAudioTrack() {
			return {};
		}
		dispose() {
			disposed = true;
		}
	},
	AudioBufferSink: class {
		async *buffers() {
			yield* chunks;
		}
	},
}));
mock.module("@/media/source", () => ({ createMediaSource: () => ({}) }));
const { decodeAudioToFloat32 } = await import("../decode-audio");
function chunk({
	channels,
	timestamp = 0,
}: {
	channels: number[][];
	timestamp?: number;
}): Chunk {
	return {
		timestamp,
		buffer: {
			length: channels[0].length,
			sampleRate: 1000,
			duration: channels[0].length / 1000,
			numberOfChannels: channels.length,
			getChannelData: (index) => Float32Array.from(channels[index]),
		},
	};
}
beforeEach(() => {
	chunks = [];
	disposed = false;
});
test("smart analysis retains opposite-phase stereo while existing average behavior is unchanged", async () => {
	chunks = [
		chunk({
			channels: [
				[0.5, -0.5, 0.25],
				[-0.5, 0.5, -0.25],
			],
		}),
	];
	const old = await decodeAudioToFloat32({ url: "blob:fixture" });
	expect(Array.from(old.samples)).toEqual([0, 0, 0]);
	const smart = await decodeAudioToFloat32({
		url: "blob:fixture",
		channelMix: "max-magnitude",
	});
	expect(Array.from(smart.samples)).toEqual([0.5, -0.5, 0.25]);
	expect(disposed).toBe(true);
});
test("missing decoded spans keep source timing and become invalid features, never false silence", async () => {
	chunks = [
		chunk({ channels: [[0.5, 0.5]], timestamp: 0.002 }),
		chunk({ channels: [[0.25]], timestamp: 0.005 }),
	];
	const decoded = await decodeAudioToFloat32({
		url: "blob:fixture",
		channelMix: "max-magnitude",
	});
	expect(decoded.samples.length).toBe(6);
	expect(Number.isNaN(decoded.samples[0])).toBe(true);
	expect(decoded.samples[2]).toBe(0.5);
	expect(Number.isNaN(decoded.samples[4])).toBe(true);
	expect(decoded.samples[5]).toBe(0.25);
});
test("invalid channel samples cannot be converted into silence", async () => {
	chunks = [chunk({ channels: [[Number.NaN], [0]] })];
	const decoded = await decodeAudioToFloat32({
		url: "blob:fixture",
		channelMix: "max-magnitude",
	});
	expect(Number.isNaN(decoded.samples[0])).toBe(true);
});
test("changing source sample rate fails without producing misleading offsets", async () => {
	const second = chunk({ channels: [[0.5]] });
	second.buffer.sampleRate = 2000;
	chunks = [chunk({ channels: [[0.5]] }), second];
	await expect(
		decodeAudioToFloat32({ url: "blob:fixture", channelMix: "max-magnitude" }),
	).rejects.toThrow("sample rate");
	expect(disposed).toBe(true);
});
