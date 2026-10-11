/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser IO test doubles. */
import { expect, mock, test } from "bun:test";
const samples = new Float32Array(96000);
const buffer = {
	numberOfChannels: 1,
	sampleRate: 48000,
	length: 96000,
	getChannelData: () => samples,
} as AudioBuffer;
mock.module("@/retime", () => ({
	getSourceTimeAtClipTime: ({ clipTime }: { clipTime: number }) => clipTime,
	renderRetimedBuffer: async () => buffer,
}));
const { renderNoiseReducedWindow } = await import("../noise-reduction");
const options = {
	audioContext: {} as BaseAudioContext,
	clip: { trimStart: 0, duration: 3600 },
	offset: 0,
	duration: 2,
	amount: 50,
};
test("cancelled work never reads source audio or starts a worker", async () => {
	const controller = new AbortController();
	controller.abort();
	let reads = 0;
	await expect(
		renderNoiseReducedWindow({
			...options,
			signal: controller.signal,
			readSource: async () => {
				reads++;
				return null;
			},
		}),
	).rejects.toThrow();
	expect(reads).toBe(0);
});
test("changing a setting cancels pending processing and releases its worker", async () => {
	const original = globalThis.Worker;
	let posted!: () => void;
	const started = new Promise<void>((resolve) => {
		posted = resolve;
	});
	let terminated = 0;
	globalThis.Worker = class {
		postMessage() {
			posted();
		}
		terminate() {
			terminated++;
		}
	} as unknown as typeof Worker;
	try {
		const controller = new AbortController();
		const task = renderNoiseReducedWindow({
			...options,
			signal: controller.signal,
			readSource: async () => ({ buffer, trimStart: 0 }),
		});
		const rejection = task.catch((error: Error) => error);
		await started;
		controller.abort();
		expect((await rejection) as Error).toHaveProperty("name", "AbortError");
		expect(terminated).toBe(1);
	} finally {
		globalThis.Worker = original;
	}
});
