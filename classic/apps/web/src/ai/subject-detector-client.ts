type Detections =
	| { available: true; data: unknown }
	| { available: false; error: string };

export function requestBrowserSubjectDetections({
	frames,
	signal,
}: {
	frames: ImageBitmap[];
	signal: AbortSignal;
}): Promise<Detections> {
	signal.throwIfAborted();
	const worker = new Worker("/browser-models/subject-worker.js");
	return new Promise((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			worker.terminate();
		};
		const abort = () => {
			stop();
			reject(signal.reason);
		};
		const fail = (error: string) => {
			stop();
			resolve({ available: false, error });
		};
		const timer = setTimeout(() => fail("Browser subject detection timed out"), 90_000);
		signal.addEventListener("abort", abort, { once: true });
		worker.onmessage = ({ data }: MessageEvent<Detections>) => {
			stop();
			resolve(data);
		};
		worker.onerror = ({ message }) => fail(message || "Browser subject detector could not start");
		try {
			worker.postMessage(frames, frames);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	});
}

/** Desktop detector transport. The recipe decides whether centered cover is allowed. */
export async function requestSubjectDetections({
	frames,
	signal,
}: {
	frames: string[];
	signal: AbortSignal;
}): Promise<Detections> {
	const response = await fetch("/api/local-subject-framing", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ frames }),
		signal,
	});
	const data = await response.json();
	if (response.status === 503)
		return {
			available: false,
			error: data.error || "Subject detector unavailable",
		};
	if (!response.ok) throw new Error(data.error || "Local detector failed");
	return { available: true, data };
}
