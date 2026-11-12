import { expect, test } from "bun:test";
import { readEnergyEnvelope } from "./energy-reader";
import { readPcmWaveEnvelope } from "./pcm-wave-envelope";
function wav(bits = 16) {
	const width = bits / 8;
	const frames = 48000;
	const bytes = new ArrayBuffer(44 + frames * width),
		view = new DataView(bytes);
	const text = ({ at, value }: { at: number; value: string }) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(at + i, value.charCodeAt(i));
	};
	text({ at: 0, value: "RIFF" });
	view.setUint32(4, 36 + frames * width, true);
	text({ at: 8, value: "WAVE" });
	text({ at: 12, value: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 48000, true);
	view.setUint32(28, 48000 * width, true);
	view.setUint16(32, width, true);
	view.setUint16(34, bits, true);
	text({ at: 36, value: "data" });
	view.setUint32(40, frames * width, true);
	for (let i = 0; i < frames; i++) {
		const at = 44 + i * width;
		if (bits === 16) view.setInt16(at, i < 24000 ? 8192 : 16384, true);
		else {
			const sample = i < 24000 ? -2_097_152 : 4_194_304;
			for (let byte = 0; byte < 3; byte++)
				view.setUint8(at + byte, sample >> (byte * 8));
		}
	}
	return new Blob([bytes], { type: "audio/wav" });
}
test("worker-compatible PCM reader preserves RMS levels and 10ms boundaries", async () => {
	const result = await readEnergyEnvelope({
		asset: { name: "fixture.wav", file: wav() },
		windowSeconds: 0.01,
	});
	expect(result.length).toBe(100);
	expect(result[20]).toBeCloseTo(0.25, 4);
	expect(result[70]).toBeCloseTo(0.5, 4);
});
test("pre-cancelled source does no decoding", async () => {
	const signal = AbortSignal.abort(new Error("cancelled"));
	await expect(
		readEnergyEnvelope({
			asset: { name: "fixture.wav", file: wav() },
			windowSeconds: 0.01,
			signal,
		}),
	).rejects.toThrow("cancelled");
});
test("bounded waveform windows preserve signed amplitude and fractional source origin", async () => {
	const result = await readEnergyEnvelope({
		asset: { name: "fixture.wav", file: wav() },
		windowSeconds: 1 / 16000,
		startSeconds: 0.1733125,
		durationSeconds: 0.5,
		sampleMode: "waveform",
	});
	expect(result.length).toBe(8000);
	expect(result[100]).toBeCloseTo(0.25, 4);
	expect(result[7000]).toBeCloseTo(0.5, 4);
});

test("local PCM range reads preserve timeline origin and zero-pad beyond the last frame", async () => {
	const result = await readPcmWaveEnvelope({
		file: wav(),
		startSeconds: 0.4,
		durationSeconds: 0.8,
	});
	expect(result?.length).toBe(80);
	expect(result?.[9]).toBe(0.25);
	expect(result?.[10]).toBe(0.5);
	expect(result?.[59]).toBe(0.5);
	expect(result?.[60]).toBe(0);
});

test("non-WAV ranges remain eligible for the general audio decoder", async () => {
	expect(
		await readPcmWaveEnvelope({
			file: new Blob(["not a WAV"]),
			startSeconds: 0,
			durationSeconds: 1,
		}),
	).toBeNull();
});

test("24-bit local WAV supports bounded RMS and signed waveform reads", async () => {
	const asset = { name: "24-bit.wav", file: wav(24) };
	const [energy, waveform] = await Promise.all([
		readEnergyEnvelope({
			asset,
			windowSeconds: 0.01,
			startSeconds: 0.4,
			durationSeconds: 0.25,
		}),
		readEnergyEnvelope({
			asset,
			windowSeconds: 1 / 16000,
			startSeconds: 0.4,
			durationSeconds: 0.25,
			sampleMode: "waveform",
		}),
	]);
	expect([energy[4], energy[20]]).toEqual([0.25, 0.5]);
	expect([waveform[400], waveform[2500]]).toEqual([-0.25, 0.5]);
});
