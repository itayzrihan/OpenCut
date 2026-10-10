import { isRenderPerfEnabled } from "./render-perf";
import { publishPerformanceReport } from "./performance-reports";

/** Timings only: never include document, media, or account contents. */
export function startOperationTiming(stage: string): () => void {
	if (!isRenderPerfEnabled()) return () => {};
	const start = performance.now();
	return () => {
		const durationMs = performance.now() - start;
		// Routine status reads must not evict useful load/playback measurements.
		if (stage.endsWith(".status") && durationMs < 50) return;
		publishPerformanceReport({
			kind: "operation",
			data: { stage, durationMs },
		});
	};
}
