import { expect, test } from "bun:test";
import { retryOverload } from "./retry-overload";

test("transient overload retries without repeating a successful request", async () => {
	let calls = 0;
	const waits: number[] = [];
	const value = await retryOverload({
		request: async () => {
			if (++calls < 3) throw new Error("Our servers are currently overloaded.");
			return "plan";
		},
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	expect(value).toBe("plan");
	expect(calls).toBe(3);
	expect(waits).toEqual([5000, 10000]);
});

test("permanent errors are not retried", async () => {
	let calls = 0;
	await expect(
		retryOverload({
			request: async () => {
				calls++;
				throw new Error("Unauthorized");
			},
		}),
	).rejects.toThrow("Unauthorized");
	expect(calls).toBe(1);
});

test("overload retries are bounded and cancellable", async () => {
	let calls = 0;
	await expect(
		retryOverload({
			request: async () => {
				calls++;
				throw new Error("overloaded");
			},
			wait: async () => {},
		}),
	).rejects.toThrow("overloaded");
	expect(calls).toBe(4);
	const abort = new AbortController();
	calls = 0;
	await expect(
		retryOverload({
			request: async () => {
				calls++;
				throw new Error("overloaded");
			},
			signal: abort.signal,
			wait: async () => {
				abort.abort();
			},
		}),
	).rejects.toThrow();
	expect(calls).toBe(1);
});
