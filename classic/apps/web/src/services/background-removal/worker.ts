import {
	env,
	pipeline,
	RawImage,
	type BackgroundRemovalPipeline,
} from "@huggingface/transformers";
import { refineBackgroundAlpha } from "opencut-wasm";
import type {
	BackgroundRemovalBackend,
	BackgroundRemovalWorkerMessage,
	BackgroundRemovalWorkerResponse,
} from "./protocol";

const MODEL_ID = "Xenova/modnet";
const MAX_TEMPORAL_GAP_SECONDS = 0.2;
const MAX_TEMPORAL_SEQUENCES = 32;

type PreviousMask = {
	alpha: Uint8Array;
	sourceTime: number;
};

let segmenter: BackgroundRemovalPipeline | null = null;
let backend: BackgroundRemovalBackend | null = null;
let initialization: Promise<void> | null = null;
let workQueue = Promise.resolve();
const previousMasks = new Map<string, PreviousMask>();
const progressFiles = new Map<string, { loaded: number; total: number }>();
let lastProgress = -1;

if (env.backends.onnx.wasm) {
	env.backends.onnx.wasm.proxy = false;
}

// Transformers.js supports this task at runtime, but its pipeline overloads do
// not retain the background-removal-specific return type after device fallback.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const createBackgroundPipeline = pipeline as unknown as (
	task: "background-removal",
	model: string,
	options: {
		device: "webgpu" | "wasm";
		dtype: "fp32" | "q8";
		progress_callback: typeof reportProgress;
	},
) => Promise<BackgroundRemovalPipeline>;

self.onmessage = (event: MessageEvent<BackgroundRemovalWorkerMessage>) => {
	const message = event.data;
	if (message.type === "init") {
		void ensureInitialized().catch(() => undefined);
		return;
	}

	workQueue = workQueue
		.then(() => processSegment(message))
		.catch((error) => {
			post({
				message: {
					type: "segment-error",
					requestId: message.requestId,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		});
};

async function ensureInitialized(): Promise<void> {
	if (segmenter) return;
	if (initialization) return initialization;

	initialization = (async () => {
		const canUseWebGpu = "gpu" in navigator;
		if (canUseWebGpu) {
			try {
				segmenter = await createBackgroundPipeline(
					"background-removal",
					MODEL_ID,
					{
						device: "webgpu",
						dtype: "fp32",
						progress_callback: reportProgress,
					},
				);
				backend = "webgpu";
				post({ message: { type: "model-ready", backend } });
				return;
			} catch {
				progressFiles.clear();
				lastProgress = -1;
			}
		}

		segmenter = await createBackgroundPipeline("background-removal", MODEL_ID, {
			device: "wasm",
			dtype: "q8",
			progress_callback: reportProgress,
		});
		backend = "wasm";
		post({ message: { type: "model-ready", backend } });
	})().catch((error) => {
		initialization = null;
		post({
			message: {
				type: "model-error",
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	});

	return initialization;
}

function reportProgress(progressInfo: {
	status?: string;
	file?: string;
	loaded?: number;
	total?: number;
}) {
	const file = progressInfo.file;
	if (!file) return;
	const loaded = progressInfo.loaded ?? 0;
	const total = progressInfo.total ?? 0;
	if (progressInfo.status === "progress" && total > 0) {
		progressFiles.set(file, { loaded, total });
	} else if (progressInfo.status === "done") {
		const known = progressFiles.get(file);
		if (known)
			progressFiles.set(file, { loaded: known.total, total: known.total });
	}

	let totalLoaded = 0;
	let totalBytes = 0;
	for (const entry of progressFiles.values()) {
		totalLoaded += entry.loaded;
		totalBytes += entry.total;
	}
	if (totalBytes <= 0) return;
	const progress = Math.floor((totalLoaded / totalBytes) * 100);
	if (progress !== lastProgress) {
		lastProgress = progress;
		post({ message: { type: "model-progress", progress } });
	}
}

async function processSegment(
	message: Extract<BackgroundRemovalWorkerMessage, { type: "segment" }>,
) {
	await ensureInitialized();
	if (!segmenter || !backend)
		throw new Error("Background model is unavailable");

	const canvas = new OffscreenCanvas(
		message.bitmap.width,
		message.bitmap.height,
	);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Unable to read the video frame");
	context.drawImage(message.bitmap, 0, 0);
	message.bitmap.close();

	// Both processor variants expose this mutable size in Transformers.js, but
	// the shared public processor union does not model it.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const imageProcessor = (segmenter.processor.image_processor ??
		segmenter.processor.feature_extractor) as
		| { size?: { shortest_edge?: number } }
		| undefined;
	if (imageProcessor) {
		imageProcessor.size = { shortest_edge: message.inputSize };
	}

	const image = RawImage.fromCanvas(canvas);
	const [output] = await segmenter(image);
	if (!output || output.channels !== 4) {
		throw new Error("The background model returned an invalid alpha matte");
	}

	const pixelCount = output.width * output.height;
	const currentAlpha = new Uint8Array(pixelCount);
	for (let index = 0; index < pixelCount; index++) {
		currentAlpha[index] = output.data[index * 4 + 3] ?? 0;
	}

	const previous = previousMasks.get(message.sequenceKey);
	const delta = previous ? message.sourceTime - previous.sourceTime : Infinity;
	const canSmooth =
		previous &&
		delta > 0 &&
		delta <= MAX_TEMPORAL_GAP_SECONDS &&
		previous.alpha.length === currentAlpha.length;
	const refined = refineBackgroundAlpha(
		currentAlpha,
		canSmooth ? previous.alpha : new Uint8Array(),
		message.maskThreshold,
		message.edgeContrast,
		message.temporalSmoothing,
	);
	previousMasks.set(message.sequenceKey, {
		alpha: refined.slice(),
		sourceTime: message.sourceTime,
	});
	while (previousMasks.size > MAX_TEMPORAL_SEQUENCES) {
		const oldestKey = previousMasks.keys().next().value;
		if (typeof oldestKey !== "string") break;
		previousMasks.delete(oldestKey);
	}

	const rgba = new Uint8ClampedArray(pixelCount * 4);
	for (let index = 0; index < pixelCount; index++) {
		const offset = index * 4;
		rgba[offset] = 255;
		rgba[offset + 1] = 255;
		rgba[offset + 2] = 255;
		rgba[offset + 3] = refined[index] ?? 0;
	}

	post({
		message: {
			type: "segment-complete",
			requestId: message.requestId,
			width: output.width,
			height: output.height,
			rgba,
		},
		transfer: [rgba.buffer],
	});
}

function post({
	message,
	transfer = [],
}: {
	message: BackgroundRemovalWorkerResponse;
	transfer?: Transferable[];
}) {
	// The app tsconfig includes DOM rather than WebWorker globals, so TypeScript
	// sees Window.postMessage even though this module only runs in a worker.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const workerPostMessage = self.postMessage as unknown as (
		message: BackgroundRemovalWorkerResponse,
		transfer: Transferable[],
	) => void;
	workerPostMessage(message, transfer);
}
