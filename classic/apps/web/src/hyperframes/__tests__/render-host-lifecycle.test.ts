/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The capture double replaces Chrome while keeping the real canonical validation, preview host and ArtifactStore. */
import { expect, spyOn, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	HyperframesCaptureSession,
	type HyperframesFrameArtifact,
} from "../capture-session";
import { prepareHyperframesPreview } from "../preview-document";
import { HyperframesRenderHost } from "../render-host";
import type { HyperframesSource } from "../types";

const source: HyperframesSource = {
	entryFile: "scene.html",
	resourceAssetIds: {},
	files: {
		"scene.html":
			'<html><body><div data-composition-id="test" data-no-timeline data-width="64" data-height="64" data-duration="2"></div></body></html>',
	},
};
const scope = { accountId: "account-a", projectId: "project-a" };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForGate({
	gate,
	signal,
}: {
	gate: Promise<void>;
	signal?: AbortSignal;
}) {
	let abort!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => reject(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
	});
	try {
		signal?.throwIfAborted();
		await Promise.race([gate, cancelled]);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

async function setup() {
	const runtime = await createCanonicalTestRuntime();
	const host = new HyperframesRenderHost(runtime);
	const events: string[] = [];
	const captures: HyperframesCaptureSession[] = [];
	const controls = {
		beforeOpen: async (_signal?: AbortSignal) => {},
		beforeFrame: async (_signal?: AbortSignal) => {},
	};
	const captureSpy = spyOn(
		HyperframesCaptureSession,
		"open",
	).mockImplementation(async (options) => {
		await controls.beforeOpen(options.signal);
		options.signal?.throwIfAborted();
		const prepared = prepareHyperframesPreview(options);
		const preview = await options.host.add({ ...options, html: prepared.html });
		const index = captures.length;
		let closed = false;
		events.push(`open:${index}`);
		const capture = {
			inspection: prepared.inspection,
			durationSeconds: 2,
			runtimeManifest: {
				sourceFingerprint: prepared.inspection.fingerprint,
				runtimeVersion: "0.8.115",
				durationSeconds: 2,
				layers: [],
				diagnostics: [],
			},
			previewUrl: preview.url,
			get isClosed() {
				return closed;
			},
			keepAlive: () => !closed && options.host.keepAlive({ id: preview.id }),
			async capture({
				timeSeconds,
				signal,
			}: {
				timeSeconds: number;
				signal?: AbortSignal;
			}) {
				if (closed) throw new Error("Capture is closed");
				events.push(`capture:${index}:${timeSeconds}`);
				await controls.beforeFrame(signal);
				signal?.throwIfAborted();
				return runtime.storeArtifact(
					new Uint8Array([1, 2, 3, timeSeconds]),
					"image/png",
					64,
					64,
					undefined,
				) as HyperframesFrameArtifact;
			},
			async close() {
				if (closed) return;
				closed = true;
				options.host.remove({ id: preview.id });
				events.push(`close:${index}`);
			},
		} as unknown as HyperframesCaptureSession;
		captures.push(capture);
		return capture;
	});
	return {
		host,
		events,
		captures,
		controls,
		open: () => host.open({ scope, source, resolveResource: async () => null }),
		async dispose() {
			await host.close();
			captureSpy.mockRestore();
			runtime.free();
		},
	};
}

test("live promotion waits for an active frame and a queued screenshot reopens once", async () => {
	const fixture = await setup();
	const started = deferred();
	const gate = deferred();
	try {
		const session = await fixture.open();
		fixture.controls.beforeFrame = async (signal) => {
			started.resolve();
			await waitForGate({ gate: gate.promise, signal });
		};
		const first = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 0,
		});
		await started.promise;
		const live = fixture.host.livePreview({ scope, id: session.id });
		const duplicate = fixture.host.livePreview({ scope, id: session.id });
		const second = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 1,
		});
		await expect(
			fixture.host.capture({ scope, id: session.id, timeSeconds: 0 }),
		).rejects.toThrow("queue is full");
		expect(fixture.events).toEqual(["open:0", "capture:0:0"]);
		gate.resolve();
		const [firstFrame, preview, duplicatePreview, secondFrame] =
			await Promise.all([first, live, duplicate, second]);
		expect(preview).toEqual(duplicatePreview);
		expect(fixture.events).toEqual([
			"open:0",
			"capture:0:0",
			"close:0",
			"open:1",
			"capture:1:1",
		]);
		expect(firstFrame.sha256).not.toBe(secondFrame.sha256);
		expect(await fixture.host.keepAlive({ scope, id: session.id })).toBe(true);
		expect(await fixture.host.livePreview({ scope, id: session.id })).toEqual(
			preview,
		);
		expect(fixture.captures.every((capture) => capture.isClosed)).toBe(true);
		expect(fixture.captures).toHaveLength(2);
		expect(await fixture.host.keepAlive({ scope, id: session.id })).toBe(true);
	} finally {
		gate.resolve();
		await fixture.dispose();
	}
});

test("closing during a lazy reopen aborts both loading and queued operations", async () => {
	const fixture = await setup();
	const started = deferred();
	const gate = deferred();
	try {
		const session = await fixture.open();
		const live = await fixture.host.livePreview({ scope, id: session.id });
		fixture.controls.beforeOpen = async (signal) => {
			started.resolve();
			await waitForGate({ gate: gate.promise, signal });
		};
		const first = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 0,
		});
		const second = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 1,
		});
		const promotion = fixture.host.livePreview({ scope, id: session.id });
		const settled = Promise.allSettled([first, second, promotion]);
		await started.promise;
		await fixture.host.closeSession({ scope, id: session.id });
		expect((await settled).map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
			"rejected",
		]);
		expect(fixture.events).toEqual(["open:0", "close:0"]);
		const address = new URL(live.url);
		expect(
			(
				await fetch(`http://127.0.0.1:${address.port}${address.pathname}`, {
					headers: { Host: address.host },
				})
			).status,
		).toBe(404);
		await expect(
			fixture.host.keepAlive({ scope, id: session.id }),
		).rejects.toThrow("unavailable");
	} finally {
		gate.resolve();
		await fixture.dispose();
	}
});

test("cancelling a queued frame preserves the running capture and subsequent promotion", async () => {
	const fixture = await setup();
	const started = deferred();
	const gate = deferred();
	try {
		const session = await fixture.open();
		fixture.controls.beforeFrame = async (signal) => {
			started.resolve();
			await waitForGate({ gate: gate.promise, signal });
		};
		const running = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 0,
		});
		await started.promise;
		const abort = new AbortController();
		const queued = fixture.host.capture({
			scope,
			id: session.id,
			timeSeconds: 1,
			signal: abort.signal,
		});
		const settled = Promise.allSettled([running, queued]);
		abort.abort();
		gate.resolve();
		expect((await settled).map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(fixture.events).toEqual(["open:0", "capture:0:0"]);
		expect(await fixture.host.keepAlive({ scope, id: session.id })).toBe(true);
		await fixture.host.livePreview({ scope, id: session.id });
		expect(fixture.events).toEqual(["open:0", "capture:0:0", "close:0"]);
	} finally {
		gate.resolve();
		await fixture.dispose();
	}
});

test("retained live deliveries expire without a capture browser and heartbeats keep active ones", async () => {
	const fixture = await setup();
	const now = Date.now();
	const time = spyOn(Date, "now").mockReturnValue(now);
	try {
		const idle = await fixture.open();
		const active = await fixture.open();
		await fixture.host.livePreview({ scope, id: idle.id });
		const live = await fixture.host.livePreview({ scope, id: active.id });
		expect(fixture.captures.every((capture) => capture.isClosed)).toBe(true);
		time.mockReturnValue(now + 90_000);
		expect(await fixture.host.keepAlive({ scope, id: active.id })).toBe(true);
		time.mockReturnValue(now + 150_000);
		// Retaining a new artifact runs the same pruning as the host timer.
		const fresh = await fixture.open();
		await fixture.host.capture({ scope, id: fresh.id, timeSeconds: 0 });
		await expect(
			fixture.host.keepAlive({ scope, id: idle.id }),
		).rejects.toThrow("unavailable");
		expect(await fixture.host.keepAlive({ scope, id: active.id })).toBe(true);
		expect(await fixture.host.livePreview({ scope, id: active.id })).toEqual(
			live,
		);
		expect(fixture.captures).toHaveLength(3);
	} finally {
		time.mockRestore();
		await fixture.dispose();
	}
});
