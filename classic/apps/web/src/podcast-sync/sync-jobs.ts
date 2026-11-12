import type { BrowserMediaSource } from "@/media/source";

const MAX_CACHED_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_ENVELOPES = 64;
const fileKeys = new WeakMap<Blob, symbol>();
const envelopeCache = new Map<symbol, Float32Array>();
let cachedEnvelopeBytes = 0;

export function syncReadConcurrency() {
	const memory = (navigator as Navigator & { deviceMemory?: number })
		.deviceMemory;
	return Math.min(
		memory != null && memory <= 4 ? 2 : 4,
		Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
	);
}

let usedWorkerSlots = 0;
const workerQueue: Array<() => boolean> = [];

function startQueuedWorkers() {
	while (workerQueue[0]?.()) workerQueue.shift();
}

function acquireWorkerSlots({
	message,
	signal,
}: {
	message: unknown;
	signal?: AbortSignal;
}): Promise<() => void> {
	const job = message as {
		type?: string;
		reference?: Float32Array;
	};
	const limit = syncReadConcurrency();
	const heavy =
		job.type === "align" ||
		job.type === "align-to-reference" ||
		job.type === "route" ||
		(job.type === "independent-probes" &&
			(job.reference?.length ?? 0) >= 250_000);
	const slots = heavy ? limit : job.type === "color" ? 2 : 1;
	return new Promise((resolve, reject) => {
		const abort = () => {
			const index = workerQueue.indexOf(start);
			if (index !== -1) workerQueue.splice(index, 1);
			reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
			startQueuedWorkers();
		};
		const start = () => {
			if (usedWorkerSlots + slots > limit) return false;
			signal?.removeEventListener("abort", abort);
			usedWorkerSlots += slots;
			resolve(() => {
				usedWorkerSlots -= slots;
				startQueuedWorkers();
			});
			return true;
		};
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		workerQueue.push(start);
		startQueuedWorkers();
	});
}

export async function readSyncEnvelope({
	asset,
	signal,
	read,
}: {
	asset: BrowserMediaSource & { name: string };
	signal: AbortSignal;
	read?: () => Promise<Float32Array>;
}) {
	signal.throwIfAborted();
	// A different File object is a different source, even after relinking to the same name.
	const file = asset.file;
	const key = file ? (fileKeys.get(file) ?? Symbol()) : undefined;
	if (file && key) fileKeys.set(file, key);
	const cached = key && envelopeCache.get(key);
	if (key && cached) {
		envelopeCache.delete(key);
		envelopeCache.set(key, cached);
		return cached;
	}
	if (read) return read();
	const envelope = await runSyncWorker<Float32Array>({
		message: { type: "read", asset },
		signal,
	});
	signal.throwIfAborted();
	if (
		key &&
		!envelopeCache.has(key) &&
		envelope.byteLength <= MAX_CACHED_ENVELOPE_BYTES
	) {
		while (
			envelopeCache.size >= MAX_CACHED_ENVELOPES ||
			cachedEnvelopeBytes + envelope.byteLength > MAX_CACHED_ENVELOPE_BYTES
		) {
			const oldest = envelopeCache.keys().next().value!;
			cachedEnvelopeBytes -= envelopeCache.get(oldest)!.byteLength;
			envelopeCache.delete(oldest);
		}
		envelopeCache.set(key, envelope);
		cachedEnvelopeBytes += envelope.byteLength;
	}
	return envelope;
}

// Host scheduling only. Signal estimation and common-clock solving live in Rust.
export async function mapConcurrent<T, R>({
	items,
	concurrency,
	task,
	signal,
}: {
	items: T[];
	concurrency: number;
	task: (item: T, signal: AbortSignal) => Promise<R>;
	signal?: AbortSignal;
}): Promise<R[]> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const output: R[] = new Array(items.length);
	let cursor = 0;
	try {
		await Promise.all(
			Array.from(
				{ length: Math.min(items.length, Math.max(1, concurrency)) },
				async () => {
					while (cursor < items.length) {
						controller.signal.throwIfAborted();
						const i = cursor++;
						try {
							output[i] = await task(items[i]!, controller.signal);
						} catch (error) {
							controller.abort(error);
							throw error;
						}
					}
				},
			),
		);
		controller.signal.throwIfAborted();
		return output;
	} finally {
		signal?.removeEventListener("abort", abort);
		controller.abort();
	}
}
export async function runSyncWorker<T>({
	message,
	signal,
}: {
	message: unknown;
	signal?: AbortSignal;
}): Promise<T> {
	const release = await acquireWorkerSlots({ message, signal });
	try {
		signal?.throwIfAborted();
		return await runWorker<T>({ message, signal });
	} finally {
		release();
	}
}

function runWorker<T>({
	message,
	signal,
}: {
	message: unknown;
	signal?: AbortSignal;
}): Promise<T> {
	return new Promise((resolve, reject) => {
		// Classic's Webpack build emits a classic worker and loads its WASM
		// chunks through importScripts.
		const worker = new Worker(new URL("./sync.worker.ts", import.meta.url));
		const cleanup = () => {
			signal?.removeEventListener("abort", abort);
			worker.terminate();
		};
		const abort = () => {
			cleanup();
			reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		worker.onmessage = (
			event: MessageEvent<{ result?: T; error?: string }>,
		) => {
			cleanup();
			if (event.data.error) reject(new Error(event.data.error));
			else if (event.data.result !== undefined) resolve(event.data.result);
			else reject(new Error("Synchronization worker returned no result"));
		};
		worker.onerror = (event) => {
			cleanup();
			reject(new Error(event.message || "Synchronization worker failed"));
		};
		worker.onmessageerror = () => {
			cleanup();
			reject(new Error("Could not read the synchronization result"));
		};
		try {
			worker.postMessage(message);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
