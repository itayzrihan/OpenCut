/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Native AudioBuffer test double. */
import { test, expect } from "bun:test";
import { MemoryAudioScratch, createAudioScratch } from "../audio-scratch";
import { PcmFile } from "../pcm-file";
const context = {
	createBuffer: (channels: number, length: number, sampleRate: number) => {
		const data = Array.from(
			{ length: channels },
			() => new Float32Array(length),
		);
		return {
			numberOfChannels: channels,
			length,
			sampleRate,
			getChannelData: (i: number) => data[i],
		};
	},
} as BaseAudioContext;
test("bounded fallback preserves PCM, isolates jobs, reclaims temporary files and enforces the shared budget", async () => {
	const scratch = new MemoryAudioScratch(64),
		other = new MemoryAudioScratch(64);
	const pcm = new PcmFile(await scratch.file("voice.pcm"), 16000, 2);
	await pcm.open();
	const audio = context.createBuffer(2, 4, 16000);
	audio.getChannelData(0).set([0.1, -0.2, 0.3, -0.4]);
	audio.getChannelData(1).set([-0.1, 0.2, -0.3, 0.4]);
	await pcm.write(audio, 2);
	await pcm.seal();
	const result = await pcm.read(context, 0, 6);
	expect(Array.from(result.getChannelData(0).subarray(2))).toEqual(
		Array.from(audio.getChannelData(0)),
	);
	expect(result.getChannelData(1)[0]).toBe(0);
	const extra = new PcmFile(await scratch.file("mix.pcm"), 16000, 2);
	await extra.open();
	await expect(extra.write(audio, 0).then(() => extra.seal())).rejects.toThrow(
		"bounded memory",
	);
	await scratch.remove("voice.pcm");
	await extra.abort();
	await extra.open();
	await extra.write(audio, 0);
	await extra.seal();
	const external = await other.file("mix.pcm");
	const writer = await external.createWritable();
	await writer.close();
	expect((await external.getFile()).size).toBe(0);
	await scratch.dispose();
	await expect(extra.handle.getFile()).rejects.toThrow("disposed");
	await other.dispose();
});
test("OPFS open failure chooses a finite fallback without deleting browser or project data", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"),
		warn = console.warn;
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			storage: {
				getDirectory: async () => {
					throw new DOMException(
						"Browser storage unavailable",
						"InvalidStateError",
					);
				},
			},
		},
	});
	console.warn = () => {};
	try {
		const scratch = await createAudioScratch();
		expect(scratch.capacityBytes).toBe(128 * 1024 ** 2);
		await scratch.dispose();
	} finally {
		console.warn = warn;
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});
