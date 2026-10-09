import { recordSpan } from "@/diagnostics/render-perf";
export class RenderQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(task: () => Promise<T> | T): Promise<T> {
		const queuedAt = performance.now();
		const result = this.tail.then(() => {
			recordSpan({
				name: "compositor.queueWait",
				durationMs: performance.now() - queuedAt,
			});
			return task();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export const compositorRenderQueue = new RenderQueue();
