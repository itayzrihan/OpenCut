import { expect, test } from "bun:test";
import { readEnergyEnvelope } from "./energy-reader";
function wav() {
	const frames = 48000;
	const bytes = new ArrayBuffer(44 + frames * 2),
		view = new DataView(bytes);
	const text = ({ at, value }: { at: number; value: string }) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(at + i, value.charCodeAt(i));
	};
	text({ at: 0, value: "RIFF" });
	view.setUint32(4, 36 + frames * 2, true);
	text({ at: 8, value: "WAVE" });
	text({ at: 12, value: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 48000, true);
	view.setUint32(28, 96000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text({ at: 36, value: "data" });
	view.setUint32(40, frames * 2, true);
	for (let i = 0; i < frames; i++)
		view.setInt16(44 + i * 2, i < 24000 ? 8192 : 16384, true);
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
