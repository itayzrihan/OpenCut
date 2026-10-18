import { afterEach, beforeEach, expect, test } from "bun:test";
import { TranscriptionService } from "./service";

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage?: (e: { data: unknown }) => void;
	onerror?: (e: { message: string }) => void;
	onmessageerror?: () => void;
	terminated = false;
	posted?: { audio: Float32Array; language: string; lowMemory: boolean };
	transfers?: Transferable[];
	previousTerminated?: boolean;
	constructor() {
		this.previousTerminated = FakeWorker.instances.at(-1)?.terminated;
		FakeWorker.instances.push(this);
	}
	// Implements the browser Worker API signature.
	// eslint-disable-next-line opencut/prefer-object-params
	postMessage(
		data: NonNullable<FakeWorker["posted"]>,
		transfer: Transferable[],
	) {
		this.posted = data;
		this.transfers = transfer;
	}
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

test("memory retry terminates old worker before transferring returned audio to its replacement", async () => {
	const pending = start({ language: "he" });
	const audio = new Float32Array([0.25, -0.5]);
	worker().emit({ type: "retry-low-memory", audio });
	const replacement = FakeWorker.instances[1];
	expect(replacement.previousTerminated).toBe(true);
	expect(replacement.posted).toEqual({
		audio,
		language: "he",
		lowMemory: true,
	});
	expect(replacement.posted?.audio).toBe(audio);
	expect(replacement.transfers).toEqual([audio.buffer]);
	worker().emit({ type: "complete", result: { text: "stale" } });
	replacement.emit({ type: "complete", result: { text: "recovered" } });
	expect(await pending).toMatchObject({ text: "recovered" });
	expect(replacement.terminated).toBe(true);
});

test("memory retry is bounded to one attempt", async () => {
	const pending = start();
	const response = { type: "retry-low-memory", audio: new Float32Array(16) };
	worker().emit(response);
	FakeWorker.instances[1].emit(response);
	await expect(pending).rejects.toThrow("out of memory after retry");
	expect(FakeWorker.instances).toHaveLength(2);
	expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
});

test("cancellation during retry progress prevents loading a second model", async () => {
	const controller = new AbortController();
	const pending = start({
		signal: controller.signal,
		onProgress: () => controller.abort(),
	});
	worker().emit({ type: "retry-low-memory", audio: new Float32Array(16) });
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(FakeWorker.instances).toHaveLength(1);
	expect(worker().terminated).toBe(true);
});

test("account change during retry progress prevents reuse of previous account audio", async () => {
	const pending = start({
		onProgress: () => {
			window.__opencutAccountId = "bob";
		},
	});
	worker().emit({ type: "retry-low-memory", audio: new Float32Array(16) });
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(FakeWorker.instances).toHaveLength(1);
});

test("cancellation interrupts the replacement worker", async () => {
	const controller = new AbortController();
	const pending = start({ signal: controller.signal });
	worker().emit({ type: "retry-low-memory", audio: new Float32Array(16) });
	controller.abort();
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("streaming reuses one quantized worker and releases it at session completion", async () => {
	const pending = new TranscriptionService().withChunkSession({
		signal: new AbortController().signal,
		run: async (transcribe) => {
			for (let i = 0; i < 3; i++)
				await transcribe({
					load: async () => new Float32Array(160),
					language: "he",
				});
		},
	});
	for (let i = 0; i < 3; i++) {
		await tick();
		expect(FakeWorker.instances).toHaveLength(1);
		expect(worker().terminated).toBe(false);
		expect(worker().posted).toMatchObject({ lowMemory: true, keepAlive: true });
		worker().emit({ type: "complete", result: { text: "ok" } });
	}
	await pending;
	expect(worker().terminated).toBe(true);
});

test("a stream GPU failure reloads only the failed window in a fresh worker", async () => {
	let loads = 0;
	const pending = new TranscriptionService().withChunkSession({
		signal: new AbortController().signal,
		run: (transcribe) =>
			transcribe({
				load: async () => {
					loads++;
					return new Float32Array(160);
				},
				language: "he",
			}),
	});
	await tick();
	worker().emit({ type: "error", error: "Array buffer allocation failed" });
	await tick();
	expect(loads).toBe(2);
	expect(FakeWorker.instances[1].previousTerminated).toBe(true);
	FakeWorker.instances[1].emit({
		type: "complete",
		result: { text: "recovered" },
	});
	expect(await pending).toMatchObject({ text: "recovered" });
});

test("window session keeps completed work and replaces only the failed worker", async () => {
	const loads: number[] = [];
	const completed: number[] = [];
	const pending = new TranscriptionService().withChunkSession({
		signal: new AbortController().signal,
		run: async (transcribe) => {
			for (let section = 0; section < 2; section++) {
				await transcribe({
					language: "en",
					load: async () => {
						loads.push(section);
						return new Float32Array(160);
					},
				});
				completed.push(section);
			}
		},
	});
	const result = {
		text: "hello",
		words: [{ text: "hello", start: 0, end: 1 }],
		segments: [],
		language: "en",
	};
	await new Promise((r) => setTimeout(r, 0));
	worker().emit({ type: "complete", result });
	await new Promise((r) => setTimeout(r, 0));
	expect(completed).toEqual([0]);
	expect(FakeWorker.instances).toHaveLength(1);
	worker().onerror?.({ message: "GPU device lost" });
	await new Promise((r) => setTimeout(r, 0));
	expect(FakeWorker.instances).toHaveLength(2);
	expect(worker().terminated).toBe(true);
	FakeWorker.instances[1].emit({ type: "complete", result });
	await pending;
	expect(loads).toEqual([0, 1, 1]);
	expect(completed).toEqual([0, 1]);
	expect(FakeWorker.instances[1].terminated).toBe(true);
});

test("long jobs recycle the model worker at a bounded interval without overlapping models", async () => {
	const pending = new TranscriptionService().withChunkSession({
		signal: new AbortController().signal,
		run: async (transcribe) => {
			for (let i = 0; i < 17; i++)
				await transcribe({
					load: async () => new Float32Array(160),
					language: "he",
				});
		},
	});
	for (let i = 0; i < 17; i++) {
		await tick();
		expect(FakeWorker.instances).toHaveLength(Math.floor(i / 8) + 1);
		const current = FakeWorker.instances.at(-1)!;
		if (i >= 8) expect(current.previousTerminated).toBe(true);
		expect(FakeWorker.instances.filter((w) => !w.terminated)).toHaveLength(1);
		current.emit({ type: "complete", result: { text: "ok" } });
	}
	await pending;
	expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
});
