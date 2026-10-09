import type { SourceWaveformSummary } from "@/media/waveform-summary";
import type { WaveformWorkerResponse } from "./worker";

/** One source per worker; File is cloned by reference, decoded PCM stays off UI. */
export function buildStreamingWaveformInWorker({
	sourceKey,
	sourceFile,
	audioUrl,
	signal,
}: {
	sourceKey: string;
	sourceFile?: File;
	audioUrl?: string;
	signal: AbortSignal;
}): Promise<SourceWaveformSummary> {
	signal.throwIfAborted();
	const worker = new Worker(new URL("./worker.ts", import.meta.url), {
		type: "module",
	});
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			worker.terminate();
		};
		const fail = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const abort = () => fail(signal.reason);
		const timeout = setTimeout(
			() => fail(new Error("Waveform worker timed out")),
			180_000,
		);
		signal.addEventListener("abort", abort, { once: true });
		worker.onerror = (event) => fail(new Error(event.message));
		worker.onmessageerror = () =>
			fail(new Error("Invalid waveform worker response"));
		worker.onmessage = (event: MessageEvent<WaveformWorkerResponse>) => {
			cleanup();
			if (event.data.type === "build-summary-complete")
				resolve(event.data.summary);
			else reject(new Error(event.data.error));
		};
		try {
			worker.postMessage({
				type: "build-stream-summary",
				sourceKey,
				sourceFile,
				audioUrl: audioUrl
					? new URL(audioUrl, window.location.href).href
					: undefined,
			});
		} catch (error) {
			fail(error);
		}
	});
}
