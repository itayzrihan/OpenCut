import { expect, test } from "bun:test";
import { prepareWithDeadline } from "../playback-preparation";

test("a stuck preparer rejects within its deadline", async () => {
	await expect(
		prepareWithDeadline({
			prepare: () => new Promise(() => {}),
			signal: new AbortController().signal,
			timeoutMs: 10,
		}),
	).rejects.toThrow("timed out");
});
test("cancellation releases a stuck preparation immediately", async () => {
	const controller = new AbortController();
	const pending = prepareWithDeadline({
		prepare: () => new Promise(() => {}),
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
});
test("synchronous failures are captured like rejected preparation", async () => {
	await expect(
		prepareWithDeadline({
			prepare: () => {
				throw new Error("decoder");
			},
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("decoder");
});

test("a rejection without a reason cannot start playback", async () => {
	await expect(
		prepareWithDeadline({
			prepare: () => Promise.reject(),
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("preparation failed");
});
