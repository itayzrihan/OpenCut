import type { ResolvedBackgroundRemovalSettings } from "@/background-removal";
import type {
	BackgroundRemovalBackend,
	BackgroundRemovalWorkerMessage,
	BackgroundRemovalWorkerResponse,
} from "./protocol";

export type BackgroundRemovalModelStatus =
	| { state: "idle" }
	| { state: "loading"; progress: number }
	| { state: "ready"; backend: BackgroundRemovalBackend }
	| { state: "error"; message: string };

export type BackgroundMaskFrame = {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
	contentHash: string;
};

type PendingSegment = {
	resolve: (
		response: Extract<
			BackgroundRemovalWorkerResponse,
			{ type: "segment-complete" }
		>,
	) => void;
	reject: (error: Error) => void;
};

class BackgroundRemovalService {
	private worker: Worker | null = null;
	private status: BackgroundRemovalModelStatus = { state: "idle" };
	private listeners = new Set<() => void>();
	private initialization: Promise<void> | null = null;
	private resolveInitialization: (() => void) | null = null;
	private rejectInitialization: ((error: Error) => void) | null = null;
	private nextRequestId = 1;
	private pending = new Map<number, PendingSegment>();
	private cache = new Map<string, BackgroundMaskFrame>();
	private inFlight = new Map<string, Promise<BackgroundMaskFrame>>();

	getStatus = (): BackgroundRemovalModelStatus => this.status;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	preload(): Promise<void> {
		if (this.status.state === "ready") return Promise.resolve();
		if (this.status.state === "error") {
			return Promise.reject(new Error(this.status.message));
		}
		if (this.initialization) return this.initialization;

		this.ensureWorker();
		this.setStatus({ state: "loading", progress: 0 });
		this.initialization = new Promise<void>((resolve, reject) => {
			this.resolveInitialization = resolve;
			this.rejectInitialization = reject;
		});
		this.worker?.postMessage({
			type: "init",
		} satisfies BackgroundRemovalWorkerMessage);
		return this.initialization;
	}

	retry(): Promise<void> {
		const restartError = new Error("Background removal model restarted");
		this.rejectInitialization?.(restartError);
		this.pending.forEach(({ reject }) => reject(restartError));
		this.pending.clear();
		this.worker?.removeEventListener("message", this.handleMessage);
		this.worker?.removeEventListener("error", this.handleWorkerError);
		this.worker?.terminate();
		this.worker = null;
		this.initialization = null;
		this.resolveInitialization = null;
		this.rejectInitialization = null;
		this.cache.clear();
		this.inFlight.clear();
		this.setStatus({ state: "idle" });
		return this.preload();
	}

	async segmentFrame({
		source,
		mediaId,
		sourceTime,
		settings,
		isPreview,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		isPreview: boolean;
	}): Promise<BackgroundMaskFrame> {
		const interval = isPreview ? 1 / settings.previewFps : 0;
		const sampledTime =
			interval > 0 ? Math.round(sourceTime / interval) * interval : sourceTime;
		const inferenceKey = [
			mediaId,
			sampledTime.toFixed(5),
			settings.inputSize,
			settings.maskThreshold.toFixed(3),
			settings.edgeContrast.toFixed(3),
			settings.temporalSmoothing.toFixed(3),
			settings.edgeFeather.toFixed(2),
		].join(":");
		const cached = this.cache.get(inferenceKey);
		if (cached) {
			this.cache.delete(inferenceKey);
			this.cache.set(inferenceKey, cached);
			return cached;
		}
		const pending = this.inFlight.get(inferenceKey);
		if (pending) return pending;

		const promise = this.runSegmentation({
			source,
			mediaId,
			sourceTime,
			settings,
			inferenceKey,
		}).finally(() => this.inFlight.delete(inferenceKey));
		this.inFlight.set(inferenceKey, promise);
		return promise;
	}

	private async runSegmentation({
		source,
		mediaId,
		sourceTime,
		settings,
		inferenceKey,
	}: {
		source: CanvasImageSource;
		mediaId: string;
		sourceTime: number;
		settings: ResolvedBackgroundRemovalSettings;
		inferenceKey: string;
	}): Promise<BackgroundMaskFrame> {
		await this.preload();
		if (!this.worker)
			throw new Error("Background removal worker is unavailable");

		const bitmap = await createImageBitmap(source);
		const requestId = this.nextRequestId++;
		const response = new Promise<
			Extract<BackgroundRemovalWorkerResponse, { type: "segment-complete" }>
		>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
		this.worker.postMessage(
			{
				type: "segment",
				requestId,
				bitmap,
				mediaId,
				sourceTime,
				sequenceKey: [
					mediaId,
					settings.inputSize,
					settings.maskThreshold.toFixed(3),
					settings.edgeContrast.toFixed(3),
				].join(":"),
				inputSize: settings.inputSize,
				maskThreshold: settings.maskThreshold,
				edgeContrast: settings.edgeContrast,
				temporalSmoothing: settings.temporalSmoothing,
			} satisfies BackgroundRemovalWorkerMessage,
			[bitmap],
		);

		const result = await response;
		const canvas = new OffscreenCanvas(result.width, result.height);
		const context = canvas.getContext("2d");
		if (!context)
			throw new Error("Unable to create the background mask texture");
		const rgba = new Uint8ClampedArray(result.rgba.length);
		rgba.set(result.rgba);
		context.putImageData(
			new ImageData(rgba, result.width, result.height),
			0,
			0,
		);
		if (settings.edgeFeather > 0) {
			const unfeathered = new OffscreenCanvas(result.width, result.height);
			const unfeatheredContext = unfeathered.getContext("2d");
			if (unfeatheredContext) {
				unfeatheredContext.putImageData(
					new ImageData(rgba, result.width, result.height),
					0,
					0,
				);
				context.clearRect(0, 0, result.width, result.height);
				context.filter = `blur(${settings.edgeFeather}px)`;
				context.drawImage(unfeathered, 0, 0);
				context.filter = "none";
			}
		}
		const frame: BackgroundMaskFrame = {
			canvas,
			width: result.width,
			height: result.height,
			contentHash: `modnet:${inferenceKey}`,
		};
		this.cache.set(inferenceKey, frame);
		while (this.cache.size > settings.cacheEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.cache.delete(oldestKey);
		}
		return frame;
	}

	private ensureWorker() {
		if (this.worker) return;
		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		this.worker.addEventListener("message", this.handleMessage);
		this.worker.addEventListener("error", this.handleWorkerError);
	}

	private handleWorkerError = (event: ErrorEvent) => {
		const error = new Error(
			event.message || "Background removal worker failed",
		);
		this.setStatus({ state: "error", message: error.message });
		this.rejectInitialization?.(error);
		this.pending.forEach(({ reject }) => reject(error));
		this.pending.clear();
		this.initialization = null;
		this.resolveInitialization = null;
		this.rejectInitialization = null;
		this.worker?.terminate();
		this.worker = null;
	};

	private handleMessage = (
		event: MessageEvent<BackgroundRemovalWorkerResponse>,
	) => {
		const response = event.data;
		switch (response.type) {
			case "model-progress":
				this.setStatus({ state: "loading", progress: response.progress });
				break;
			case "model-ready":
				this.setStatus({ state: "ready", backend: response.backend });
				this.resolveInitialization?.();
				this.resolveInitialization = null;
				this.rejectInitialization = null;
				break;
			case "model-error": {
				const error = new Error(response.error);
				this.setStatus({ state: "error", message: response.error });
				this.rejectInitialization?.(error);
				this.initialization = null;
				this.resolveInitialization = null;
				this.rejectInitialization = null;
				break;
			}
			case "segment-complete": {
				const pending = this.pending.get(response.requestId);
				this.pending.delete(response.requestId);
				pending?.resolve(response);
				break;
			}
			case "segment-error": {
				const pending = this.pending.get(response.requestId);
				this.pending.delete(response.requestId);
				pending?.reject(new Error(response.error));
				break;
			}
		}
	};

	private setStatus(status: BackgroundRemovalModelStatus) {
		this.status = status;
		this.listeners.forEach((listener) => listener());
	}
}

export const backgroundRemovalService = new BackgroundRemovalService();
