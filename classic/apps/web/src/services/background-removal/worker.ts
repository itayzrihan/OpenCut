import type { BackgroundRemovalPipeline } from "@huggingface/transformers";
import type {
	BackgroundRemovalBackend,
	BackgroundRemovalWorkerMessage,
	BackgroundRemovalWorkerResponse,
} from "./protocol";

const MODEL_ID = "Xenova/modnet";
const LOCAL_MODEL_ROOT = new URL("/models/", self.location.origin).href;
const LOCAL_ONNX_RUNTIME_ROOT = new URL("/onnxruntime/", self.location.origin)
	.href;
const MAX_TEMPORAL_GAP_SECONDS = 0.2;
const MAX_TEMPORAL_SEQUENCES = 32;

type PreviousMask = {
	alpha: Uint8Array;
	sourceTime: number;
};

let segmenter: BackgroundRemovalPipeline | null = null;
let rawImageClass:
	| (typeof import("@huggingface/transformers"))["RawImage"]
	| null = null;
let backend: BackgroundRemovalBackend | null = null;
let initialization: Promise<void> | null = null;
let workQueue = Promise.resolve();
const previousMasks = new Map<string, PreviousMask>();
const progressFiles = new Map<string, { loaded: number; total: number }>();
const cancelledRequests = new Set<string>();
let lastProgress = -1;
let activeGeneration = 0;

self.onmessage = (event: MessageEvent<BackgroundRemovalWorkerMessage>) => {
	const message = event.data;
	if (message.type === "init") {
		activeGeneration = message.generation;
		void ensureInitialized({
			preferredBackend: message.backend ?? "auto",
		}).catch(() => undefined);
		return;
	}
	if (message.type === "cancel") {
		cancelledRequests.add(
			buildRequestKey({
				generation: message.generation,
				requestId: message.requestId,
			}),
		);
		return;
	}

	const requestKey = buildRequestKey(message);
	workQueue = workQueue
		.then(() => processSegment(message))
		.catch((error) => {
			if (cancelledRequests.has(requestKey)) return;
			post({
				message: {
					type: "segment-error",
					generation: message.generation,
					requestId: message.requestId,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		})
		.finally(() => {
			cancelledRequests.delete(requestKey);
		});
};

async function ensureInitialized({
	preferredBackend = "auto",
}: {
	preferredBackend?: "auto" | BackgroundRemovalBackend;
} = {}): Promise<void> {
	if (segmenter) return;
	if (initialization) return initialization;

	initialization = (async () => {
		await verifyLocalRuntimeAssets();
		post({
			message: {
				type: "model-progress",
				generation: activeGeneration,
				progress: 10,
			},
		});
		const transformers = await import("@huggingface/transformers");
		post({
			message: {
				type: "model-progress",
				generation: activeGeneration,
				progress: 20,
			},
		});
		const { env, pipeline, RawImage } = transformers;
		if (env.backends.onnx.wasm) {
			env.backends.onnx.wasm.proxy = false;
			env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
				? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
				: 1;
			env.backends.onnx.wasm.wasmPaths = LOCAL_ONNX_RUNTIME_ROOT;
		}
		// Keep the first preview frame deterministic and available offline.
		env.allowLocalModels = true;
		env.allowRemoteModels = false;
		env.localModelPath = LOCAL_MODEL_ROOT;
		rawImageClass = RawImage;

		// Transformers.js supports this task at runtime, but its pipeline
		// overloads do not retain the background-removal-specific return type
		// after device fallback.
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
		// The owner terminates this worker and starts a clean WASM worker if
		// WebGPU graph compilation exceeds its bounded startup timeout.
		const canUseWebGpu = preferredBackend !== "wasm" && "gpu" in navigator;
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
				post({
					message: {
						type: "model-ready",
						generation: activeGeneration,
						backend,
					},
				});
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
		post({
			message: {
				type: "model-ready",
				generation: activeGeneration,
				backend,
			},
		});
	})().catch((error) => {
		initialization = null;
		post({
			message: {
				type: "model-error",
				generation: activeGeneration,
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	});

	return initialization;
}

async function verifyLocalRuntimeAssets(): Promise<void> {
	const urls = [
		"/onnxruntime/ort-wasm-simd-threaded.wasm",
		"/models/Xenova/modnet/config.json",
		"/models/Xenova/modnet/preprocessor_config.json",
		"/models/Xenova/modnet/onnx/model_quantized.onnx",
	];
	const responses = await Promise.all(
		urls.map((url) =>
			fetch(new URL(url, self.location.origin), {
				method: "HEAD",
				cache: "force-cache",
			}),
		),
	);
	const unavailableIndex = responses.findIndex((response) => !response.ok);
	if (unavailableIndex >= 0) {
		throw new Error(
			`Local background-removal asset is unavailable: ${urls[unavailableIndex]}`,
		);
	}
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
		post({
			message: {
				type: "model-progress",
				generation: activeGeneration,
				progress,
			},
		});
	}
}

async function processSegment(
	message: Extract<BackgroundRemovalWorkerMessage, { type: "segment" }>,
) {
	const requestKey = buildRequestKey(message);
	let bitmapClosed = false;
	const closeBitmap = () => {
		if (bitmapClosed) return;
		bitmapClosed = true;
		message.bitmap.close();
	};
	try {
		if (
			message.generation !== activeGeneration ||
			cancelledRequests.has(requestKey)
		) {
			return;
		}
		await ensureInitialized();
		if (!segmenter || !backend || !rawImageClass)
			throw new Error("Background model is unavailable");
		if (cancelledRequests.has(requestKey)) return;

		const canvas = new OffscreenCanvas(
			message.bitmap.width,
			message.bitmap.height,
		);
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Unable to read the video frame");
		context.drawImage(message.bitmap, 0, 0);
		closeBitmap();

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

		const image = rawImageClass.fromCanvas(canvas);
		const [output] = await segmenter(image);
		if (cancelledRequests.has(requestKey)) return;
		if (!output || output.channels !== 4) {
			throw new Error("The background model returned an invalid alpha matte");
		}

		const pixelCount = output.width * output.height;
		const currentAlpha = new Uint8Array(pixelCount);
		for (let index = 0; index < pixelCount; index++) {
			currentAlpha[index] = output.data[index * 4 + 3] ?? 0;
		}

		const previous = previousMasks.get(message.sequenceKey);
		const delta = previous
			? message.sourceTime - previous.sourceTime
			: Infinity;
		const canSmooth =
			previous &&
			delta > 0 &&
			delta <= MAX_TEMPORAL_GAP_SECONDS &&
			previous.alpha.length === currentAlpha.length;
		const refined = refineAlphaMask({
			current: currentAlpha,
			previous: canSmooth ? previous.alpha : null,
			maskThreshold: message.maskThreshold,
			edgeContrast: message.edgeContrast,
			temporalSmoothing: message.temporalSmoothing,
		});
		previousMasks.set(message.sequenceKey, {
			alpha: refined.slice(),
			sourceTime: message.sourceTime,
		});
		while (previousMasks.size > MAX_TEMPORAL_SEQUENCES) {
			const oldestKey = previousMasks.keys().next().value;
			if (typeof oldestKey !== "string") break;
			previousMasks.delete(oldestKey);
		}

		if (cancelledRequests.has(requestKey)) return;
		post({
			message: {
				type: "segment-complete",
				generation: message.generation,
				requestId: message.requestId,
				width: output.width,
				height: output.height,
				alpha: refined,
			},
			transfer: [refined.buffer],
		});
	} finally {
		closeBitmap();
	}
}

function refineAlphaMask({
	current,
	previous,
	maskThreshold,
	edgeContrast,
	temporalSmoothing,
}: {
	current: Uint8Array;
	previous: Uint8Array | null;
	maskThreshold: number;
	edgeContrast: number;
	temporalSmoothing: number;
}): Uint8Array {
	// This is the worker-local numeric form of Rust's
	// background_removal::refine_alpha_mask. Keeping the tiny pixel loop here
	// avoids loading the complete application WASM module before the worker can
	// receive its first message.
	const threshold = Math.min(0.95, Math.max(0.05, maskThreshold));
	const contrast = Math.min(2.5, Math.max(0.5, edgeContrast));
	const smoothing = Math.min(0.85, Math.max(0, temporalSmoothing));
	const canSmooth =
		previous !== null &&
		previous.length > 0 &&
		previous.length === current.length;
	const refined = new Uint8Array(current.length);
	for (let index = 0; index < current.length; index++) {
		const currentAlpha = (current[index] ?? 0) / 255;
		const stableAlpha = canSmooth
			? currentAlpha * (1 - smoothing) +
				((previous?.[index] ?? 0) / 255) * smoothing
			: currentAlpha;
		const contrasted = (stableAlpha - threshold) * contrast + 0.5;
		refined[index] = Math.round(Math.min(1, Math.max(0, contrasted)) * 255);
	}
	return refined;
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

function buildRequestKey({
	generation,
	requestId,
}: {
	generation: number;
	requestId: number;
}): string {
	return `${generation}:${requestId}`;
}
