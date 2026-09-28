import { setTimeout as delay } from "node:timers/promises";

/** Retry failed inference only; no editor mutation is executed here. */
export async function retryOverload<T>({
	request,
	signal,
	wait = (ms) => delay(ms, undefined, { signal }),
}: {
	request: () => Promise<T>;
	signal?: AbortSignal;
	wait?: (ms: number) => Promise<unknown>;
}): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			return await request();
		} catch (error) {
			signal?.throwIfAborted();
			const message = error instanceof Error ? error.message : "";
			if (
				attempt >= 3 ||
				!/overloaded|temporarily unavailable|\(50[234]\)/i.test(message)
			)
				throw error;
			await wait(5000 * 2 ** attempt);
		}
	}
}
