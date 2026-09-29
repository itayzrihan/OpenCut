import { afterEach, beforeEach, expect, test } from "bun:test";
import { TranscriptionService } from "./service";

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage?: (e: { data: unknown }) => void;
	onerror?: (e: { message: string }) => void;
	onmessageerror?: () => void;
	terminated = false;
	constructor() {
		FakeWorker.instances.push(this);
	}
	postMessage() {}
	terminate() {
		this.terminated = true;
	}
	emit(data: unknown) {
		this.onmessage?.({ data });
	}
}
let original: PropertyDescriptor[];
const keys = ["window", "Worker", "isSecureContext", "navigator"];
beforeEach(() => {
	original = keys.map(
		(key) => Object.getOwnPropertyDescriptor(globalThis, key)!,
	);
	const window = Object.assign(new EventTarget(), {
		__opencutAccountId: "alice",
	});
	for (const [key, value] of Object.entries({
		window,
		Worker: FakeWorker,
		isSecureContext: true,
		navigator: {},
	}))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	FakeWorker.instances = [];
});
afterEach(() =>
	keys.forEach((key, i) => {
		if (original[i]) Object.defineProperty(globalThis, key, original[i]);
		else Reflect.deleteProperty(globalThis, key);
	}),
);
const start = (options = {}) =>
	new TranscriptionService().transcribe({
		audioData: new Float32Array(160),
		...options,
	});
const worker = () => FakeWorker.instances[0];
test("abort interrupts model download, terminates the worker and ignores late results", async () => {
	const abort = new AbortController();
	const pending = start({ signal: abort.signal });
	worker().emit({
		type: "progress",
		progress: { status: "loading-model", progress: 12 },
	});
	abort.abort();
	worker().emit({ type: "complete", result: { text: "late" } });
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(worker().terminated).toBe(true);
});
test("an already aborted request never starts a worker", async () => {
	await expect(start({ signal: AbortSignal.abort() })).rejects.toHaveProperty(
		"name",
		"AbortError",
	);
	expect(FakeWorker.instances).toHaveLength(0);
});
test("account switching discards the old account result", async () => {
	const pending = start();
	window.__opencutAccountId = "bob";
	worker().emit({ type: "complete", result: { text: "alice private audio" } });
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(worker().terminated).toBe(true);
});
test("page departure interrupts inference", async () => {
	const pending = start();
	window.dispatchEvent(new Event("pagehide"));
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(worker().terminated).toBe(true);
});
test("worker crash rejects and frees resources; retry uses a fresh worker", async () => {
	const pending = start();
	worker().onerror?.({ message: "GPU out of memory" });
	await expect(pending).rejects.toThrow("GPU out of memory");
	expect(worker().terminated).toBe(true);
	const retry = start();
	const result = {
		text: "hello",
		words: [{ text: "hello", start: 0, end: 1 }],
		segments: [],
		language: "en",
	};
	FakeWorker.instances[1].emit({ type: "complete", result });
	expect(await retry).toEqual(result);
	expect(FakeWorker.instances[1].terminated).toBe(true);
});
test("browser GPU lock serializes frames and cancellation while queued creates no worker", async () => {
	Object.defineProperty(navigator, "locks", {
		value: {
			request: (_: string, { signal }: { signal: AbortSignal }) =>
				new Promise((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					}),
				),
		},
	});
	const abort = new AbortController();
	const pending = start({ signal: abort.signal });
	abort.abort();
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(FakeWorker.instances).toHaveLength(0);
});
