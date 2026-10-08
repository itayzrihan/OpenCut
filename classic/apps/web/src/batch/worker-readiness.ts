/** Browser host readiness, not project state. Warm the iframe before locking/saving. */
export function createWorkerReadiness() {
	let ready = false;
	const listeners = new Set<() => void>();
	return {
		markReady: () => {
			ready = true;
			for (const resolve of listeners) resolve();
			listeners.clear();
		},
		wait: ({ timeoutMs = 90_000 }: { timeoutMs?: number } = {}) => {
			if (ready) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					listeners.delete(done);
					reject(
						new Error(
							"The background editor could not load. Nothing was queued; please try again.",
						),
					);
				}, timeoutMs);
				listeners.add(done);
			});
		},
	};
}
