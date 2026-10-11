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
export function runSyncWorker<T>({
	message,
	signal,
}: {
	message: unknown;
	signal?: AbortSignal;
}): Promise<T> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./sync.worker.ts", import.meta.url), {
			type: "module",
		});
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
		try {
			worker.postMessage(message);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
