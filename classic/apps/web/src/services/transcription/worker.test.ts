import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type { AutomaticSpeechRecognitionOutput } from "@huggingface/transformers-v4";
import type { WorkerMessage, WorkerResponse } from "./worker";
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
let loadOptions: Record<string, unknown>,
	inferenceOptions: Record<string, unknown>,
	loadedModel: string;
let output: AutomaticSpeechRecognitionOutput,
	failLoad = false,
	disposed = 0;
let failure: Error | undefined;
let failInference = false;
let transferred: Transferable[] | undefined;
const messages: WorkerResponse[] = [];
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);
const worker = {
	// Implements the browser worker global's postMessage signature.
	// eslint-disable-next-line opencut/prefer-object-params
	postMessage: (
		value: WorkerResponse,
		options?: StructuredSerializeOptions,
	) => {
		transferred = options?.transfer;
		messages.push(value);
	},
	onmessage: null as
		| ((event: Pick<MessageEvent<WorkerMessage>, "data">) => Promise<void>)
		| null,
};
mock.module("@huggingface/transformers-v4", () => ({
	env,
	TextStreamer: class {},
	// Matches the fixed third-party Transformers pipeline signature.
	// eslint-disable-next-line opencut/prefer-object-params
	pipeline: async (
		_: string,
		model: string,
		options: Record<string, unknown>,
	) => {
		loadedModel = model;
		loadOptions = options;
		if (failLoad) throw new Error("Model download failed");
		if (failure && !failInference) throw failure;
		const pipe = Object.assign(
			async (_: unknown, settings: Record<string, unknown>) => {
				inferenceOptions = settings;
				if (failure) throw failure;
				return output;
			},
			{
				tokenizer: {},
				model: { sessions: {}, generate: async () => undefined },
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
	failure = undefined;
	failInference = false;
	transferred = undefined;
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
const run = (lowMemory = false) => {
	if (!worker.onmessage)
		throw new Error("Transcription worker did not initialize");
	return worker.onmessage({
		data: { audio: new Float32Array(32000), language: "he", lowMemory },
	});
};

function lastError(): string {
	const value = messages.at(-1);
	if (value?.type !== "error") throw new Error("Expected a worker error");
	return value.error;
}
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
	const first = messages[0];
	if (first?.type !== "progress") throw new Error("Expected CPU progress");
	expect(first.progress.message).toContain("CPU");
});
test("download failure is returned, never replaced with a host transcription request", async () => {
	failLoad = true;
	await run();
	expect(messages.at(-1)).toMatchObject({ type: "error" });
	expect(lastError()).toContain("Model download failed");
	expect(messages.some((m) => m.type === "complete")).toBe(false);
});
test("untimed text fails instead of producing unusable caption sources", async () => {
	output = { text: "שלום", chunks: [] };
	await run();
	expect(lastError()).toContain("did not return timed words");
	expect(disposed).toBe(1);
});

test("GPU allocation failure returns audio ownership for a fresh-worker retry", async () => {
	failure = new RangeError("Array buffer allocation failed");
	await run();
	const response = messages.at(-1);
	if (response?.type !== "retry-low-memory") throw new Error("Expected retry");
	expect(response.audio.length).toBe(32000);
	expect(transferred).toEqual([response.audio.buffer]);
	expect(disposed).toBe(0);
});

test("inference allocation failure disposes the pipeline and requests recovery", async () => {
	failure = new Error("GPU out of memory");
	failInference = true;
	await run();
	expect(messages.at(-1)?.type).toBe("retry-low-memory");
	expect(disposed).toBe(1);
});

test("recovery keeps pinned timestamped weights with a smaller q4 encoder", async () => {
	await run(true);
	expect(loadedModel).toBe(BROWSER_WHISPER_MODEL);
	expect(loadOptions).toMatchObject({
		revision: BROWSER_WHISPER_REVISION,
		device: "webgpu",
		dtype: { encoder_model: "q4", decoder_model_merged: "q4" },
	});
	expect(inferenceOptions.return_timestamps).toBe("word");
	expect(messages.at(-1)?.type).toBe("complete");
});

test("recovery allocation failure stops with actionable guidance", async () => {
	failure = new RangeError("Array buffer allocation failed");
	await run(true);
	expect(lastError()).toContain("even with the reduced-memory model");
	expect(lastError()).toContain(
		"Model loading failed before transcription started",
	);
	expect(lastError()).toContain("new tab");
	expect(messages.at(-1)).toMatchObject({
		diagnostic: expect.stringContaining(
			"loading-model; webgpu; lowMemory=true",
		),
	});
	expect(messages.some((m) => m.type === "retry-low-memory")).toBe(false);
});

test("CPU allocation failure does not retry with incompatible GPU weights", async () => {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {},
	});
	failure = new RangeError("Array buffer allocation failed");
	await run();
	expect(lastError()).toContain("using the CPU model");
	expect(lastError()).toContain("WebGPU");
	expect(messages.some((m) => m.type === "retry-low-memory")).toBe(false);
});

test("streaming keeps the loaded model for subsequent bounded sections", async () => {
	await worker.onmessage!({
		data: {
			audio: new Float32Array(32000),
			language: "he",
			lowMemory: true,
			keepAlive: true,
		},
	});
	expect(disposed).toBe(0);
	// A second pipeline construction would fail, proving resident reuse.
	failLoad = true;
	await worker.onmessage!({
		data: {
			audio: new Float32Array(32000),
			language: "he",
			lowMemory: true,
			keepAlive: true,
		},
	});
	expect(messages.at(-1)).toMatchObject({ type: "complete" });
	expect(disposed).toBe(0);
});
