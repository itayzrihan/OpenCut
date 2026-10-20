/* eslint-disable opencut/prefer-object-params -- Test doubles match the positional platform interfaces. */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Platform PCM file doubles. */
import { expect, test } from "bun:test";
import { PcmFile } from "../pcm-file";
function audio(channels: number, length: number, sampleRate: number) {
	const data = Array.from({ length: channels }, () => new Float32Array(length));
	return {
		numberOfChannels: channels,
		length,
		sampleRate,
		getChannelData: (ch: number) => data[ch],
	} as AudioBuffer;
}
const context = { createBuffer: audio } as BaseAudioContext;
function file() {
	let bytes = new Uint8Array(0),
		maxWrite = 0,
		aborted = false;
	const handle = {
		createWritable: async () => ({
			write: async (c: { position: number; data: Uint8Array }) => {
				maxWrite = Math.max(maxWrite, c.data.length);
				if (c.position + c.data.length > bytes.length) {
					const next = new Uint8Array(c.position + c.data.length);
					next.set(bytes);
					bytes = next;
				}
				bytes.set(c.data, c.position);
			},
			truncate: async (size: number) => {
				const next = new Uint8Array(size);
				next.set(bytes.subarray(0, size));
				bytes = next;
			},
			close: async () => {},
			abort: async () => {
				aborted = true;
			},
		}),
		getFile: async () => new File([bytes], "test.pcm"),
	} as unknown as FileSystemFileHandle;
	return { handle, maxWrite: () => maxWrite, aborted: () => aborted };
}
test("PCM writes are bounded, preserve stereo and zero-pad sparse/negative reads", async () => {
	const f = file(),
		pcm = new PcmFile(f.handle, 44100, 2);
	await pcm.open();
	const input = audio(2, 200000, 44100);
	for (let i = 0; i < input.length; i++) {
		input.getChannelData(0)[i] = i / 200000;
		input.getChannelData(1)[i] = -i / 200000;
	}
	await pcm.write(input, 7);
	await pcm.seal();
	expect(f.maxWrite()).toBeLessThanOrEqual(512 * 1024);
	expect(pcm.frames).toBe(200007);
	const first = await pcm.read(context, -2, 12);
	expect(Array.from(first.getChannelData(0).subarray(0, 9))).toEqual(
		Array(9).fill(0),
	);
	expect(first.getChannelData(0)[10]).toBe(input.getChannelData(0)[1]);
	const last = await pcm.read(context, 200005, 5);
	expect(last.getChannelData(1)[1]).toBe(input.getChannelData(1)[199999]);
	expect(last.getChannelData(0)[2]).toBe(0);
	await expect(pcm.read(context, 0, 44100 * 36000)).rejects.toThrow(
		"memory budget",
	);
});
test("invalid write ranges fail before disk IO and aborted writers cannot be reused", async () => {
	const f = file(),
		pcm = new PcmFile(f.handle, 44100, 1);
	await pcm.open();
	await expect(pcm.write(audio(1, 4, 44100), -1)).rejects.toThrow(
		"Invalid PCM",
	);
	await pcm.abort();
	expect(f.aborted()).toBe(true);
	await expect(pcm.write(audio(1, 4, 44100), 0)).rejects.toThrow("not open");
});

test("refreshes one invalidated OPFS snapshot without changing samples or retrying changed audio", async () => {
	const f = file();
	const getFile = f.handle.getFile.bind(f.handle);
	let snapshots = 0;
	let wrongSize = false;
	f.handle.getFile = async () => {
		snapshots++;
		if (snapshots === 1)
			return {
				slice: () => ({
					arrayBuffer: async () => {
						throw new DOMException(
							"Cached file state changed",
							"NotReadableError",
						);
					},
				}),
			} as unknown as File;
		return wrongSize ? new File([], "changed.pcm") : getFile();
	};
	const pcm = new PcmFile(f.handle, 16000, 1);
	await pcm.open();
	const input = audio(1, 4, 16000);
	input.getChannelData(0).set([0.2, -0.3, 0.4, 0.5]);
	await pcm.write(input, 0);
	await pcm.seal();
	expect(Array.from((await pcm.read(context, 0, 4)).getChannelData(0))).toEqual(
		Array.from(input.getChannelData(0)),
	);
	expect(snapshots).toBe(2);
	snapshots = 0;
	await pcm.open();
	await pcm.write(input, 0);
	await pcm.seal();
	wrongSize = true;
	await expect(pcm.read(context, 0, 4)).rejects.toThrow("changed size");
});
