/** Bound host preparation; never start the clock with missing required media. */
export function prepareWithDeadline({
	prepare,
	signal,
	timeoutMs = 30_000,
}: {
	prepare: () => Promise<void>;
	signal: AbortSignal;
	timeoutMs?: number;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Playback cancelled", "AbortError"));
			return;
		}
		const onAbort = () =>
			finish(new DOMException("Playback cancelled", "AbortError"));
		const timer = setTimeout(
			() =>
				finish(new Error("Playback preparation timed out. Try Play again.")),
			timeoutMs,
		);
		function finish(error?: unknown) {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve();
		}
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			void prepare().then(
				() => finish(),
				(error: unknown) =>
					finish(error ?? new Error("Playback preparation failed")),
			);
		} catch (error) {
			finish(error ?? new Error("Playback preparation failed"));
		}
	});
}
