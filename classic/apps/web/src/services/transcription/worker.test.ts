import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import {
	BROWSER_WHISPER_MODEL,
	BROWSER_WHISPER_REVISION,
	BROWSER_WHISPER_CPU_MODEL,
	BROWSER_WHISPER_CPU_REVISION,
} from "@/transcription/models";

const env = {
	allowLocalModels: true,
	useBrowserCache: false,
	backends: { onnx: { wasm: { numThreads: 8 } } },
};
let loadOptions: any, inferenceOptions: any, loadedModel: string;
let output: any,
	failLoad = false,
	disposed = 0;
const messages: any[] = [];
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);
const worker = {
	postMessage: (value: unknown) => messages.push(value),
	onmessage: null as any,
};
mock.module("@huggingface/transformers-v4", () => ({
	env,
	TextStreamer: class {},
	pipeline: async (_: string, model: string, options: any) => {
		loadedModel = model;
		loadOptions = options;
		if (failLoad) throw new Error("Model download failed");
		const pipe = Object.assign(
			async (_: unknown, settings: any) => {
				inferenceOptions = settings;
				return output;
			},
			{
				tokenizer: {},
				dispose: async () => {
					disposed++;
				},
			},
		);
		return pipe;
	},
}));
beforeAll(async () => {
	Object.defineProperty(globalThis, "self", {
		configurable: true,
		value: worker,
	});
	await import("./worker");
});
beforeEach(() => {
	messages.length = 0;
	failLoad = false;
	disposed = 0;
	output = {
		text: " שלום עולם",
		chunks: [
			{ text: " שלום", timestamp: [0.2, 0.7] },
			{ text: " עולם", timestamp: [0.7, 1.1] },
		],
	};
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			gpu: {
				requestAdapter: async () => ({ features: new Set(["shader-f16"]) }),
			},
		},
	});
});
afterAll(() => {
	for (const [key, descriptor] of [
		["self", originalSelf],
		["navigator", originalNavigator],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
const run = () =>
	worker.onmessage({
		data: { audio: new Float32Array(32000), language: "he" },
	});
test("pins GPU timestamped weights, caches public files and preserves word timing", async () => {
	await run();
	expect(loadedModel).toBe(BROWSER_WHISPER_MODEL);
	expect(loadOptions).toMatchObject({
		revision: BROWSER_WHISPER_REVISION,
		device: "webgpu",
		dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
	});
	expect(inferenceOptions).toMatchObject({
		return_timestamps: "word",
		language: "he",
		chunk_length_s: 30,
		stride_length_s: 5,
	});
	expect(env.allowLocalModels).toBe(false);
	expect(env.useBrowserCache).toBe(true);
	expect(messages.at(-1)).toMatchObject({
		type: "complete",
		result: {
			words: [
				{ text: "שלום", start: 0.2, end: 0.7 },
				{ text: "עולם", start: 0.7, end: 1.1 },
			],
		},
	});
	expect(disposed).toBe(1);
});
test("without fp16 WebGPU uses the local WASM-compatible timestamped conversion", async () => {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {},
	});
	await run();
	expect(loadedModel).toBe(BROWSER_WHISPER_CPU_MODEL);
	expect(loadOptions).toMatchObject({
		revision: BROWSER_WHISPER_CPU_REVISION,
		device: "wasm",
		dtype: "q8",
	});
	expect(env.backends.onnx.wasm.numThreads).toBe(1);
	expect(messages[0].progress.message).toContain("CPU");
});
test("download failure is returned, never replaced with a host transcription request", async () => {
	failLoad = true;
	await run();
	expect(messages.at(-1)).toMatchObject({ type: "error" });
	expect(messages.at(-1).error).toContain("Model download failed");
	expect(messages.some((m) => m.type === "complete")).toBe(false);
});
test("untimed text fails instead of producing unusable caption sources", async () => {
	output = { text: "שלום", chunks: [] };
	await run();
	expect(messages.at(-1).error).toContain("did not return timed words");
	expect(disposed).toBe(1);
});
