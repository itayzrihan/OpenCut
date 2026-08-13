import { describe, expect, test } from "bun:test";
import { RenderQueue } from "@/services/renderer/compositor/render-queue";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
}

describe("renderer compositor queue", () => {
	test("keeps render and async frame consumption exclusive", async () => {
		const queue = new RenderQueue();
		const firstConsumer = deferred<void>();
		const events: string[] = [];

		const first = queue.run(async () => {
			events.push("first-render");
			await firstConsumer.promise;
			events.push("first-consume");
		});
		const second = queue.run(async () => {
			events.push("second-render");
		});

		await Promise.resolve();
		expect(events).toEqual(["first-render"]);

		firstConsumer.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first-render", "first-consume", "second-render"]);
	});

	test("continues after a failed render or consumer", async () => {
		const queue = new RenderQueue();
		const failure = queue.run(async () => {
			throw new Error("encode failed");
		});
		const next = queue.run(() => "next frame");

		await expect(failure).rejects.toThrow("encode failed");
		expect(await next).toBe("next frame");
	});
});
