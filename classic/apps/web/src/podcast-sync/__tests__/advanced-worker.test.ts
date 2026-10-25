import { expect, mock, test } from "bun:test";
const windows: any[] = [];
let compared: any;
mock.module("../energy-reader", () => ({
	readEnergyEnvelope: async (o: any) => {
		windows.push(o);
		return new Float32Array(Math.round(o.durationSeconds * 16000)).fill(
			o.asset.name === "second" ? 0.8 : 0.2,
		);
	},
}));
mock.module("opencut-wasm", () => ({
	estimatePodcastPrecision: (options: any) => {
		compared = options;
		return { offsetSeconds: 0, confidence: 1 };
	},
}));
const messages: any[] = [];
const worker = {
	onmessage: undefined as any,
	postMessage: (m: any) => messages.push(m),
};
Object.defineProperty(globalThis, "self", {
	configurable: true,
	value: worker,
});
await import("../sync.worker");
test("waveform verification reads through a segment boundary without decoding a virtual URL", async () => {
	const asset = (name: string) => ({ name, url: `blob:${name}` });
	await worker.onmessage({
		data: {
			type: "precision",
			reference: asset("camera"),
			target: asset("first"),
			targetSegments: [
				{ asset: asset("first"), start: 0, duration: 1800.15 },
				{ asset: asset("second"), start: 1800.15, duration: 100 },
			],
			window: { referenceStart: 0, targetStart: 1799.15, durationSeconds: 2 },
		},
	});
	expect(messages[0].error).toBeUndefined();
	const mic = windows.filter((w) => w.asset.name !== "camera");
	expect(
		mic.map((w) => [w.asset.name, w.startSeconds, w.durationSeconds]),
	).toEqual([
		["first", 1799.15, 1],
		["second", 0, 1],
	]);
	expect(compared.target.length).toBe(32000);
	expect(compared.target[15999]).toBeCloseTo(0.2);
	expect(compared.target[16000]).toBeCloseTo(0.8);
});
