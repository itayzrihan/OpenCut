import { expect, test } from "bun:test";
import { HyperframesRenderClient } from "../render-client";
import { composition, renderFixture } from "./render-client-fixture";

test("preview resolutions share a browser but never substitute for full-resolution export", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	const input = {
		composition: composition(),
		timeSeconds: 1,
		target: fixture.target,
	};
	try {
		await client.renderTo({ ...input, previewScale: 0.25 });
		await client.renderTo({ ...input, previewScale: 0.5 });
		await client.renderTo(input);
		await client.renderTo({ ...input, previewScale: 0.25 });
		await client.renderTo(input);
		expect(fixture.count("open")).toBe(1);
		expect(
			fixture.calls.filter(({ action }) => action === "capture"),
		).toMatchObject([
			{ previewScale: 0.25 },
			{ previewScale: 0.5 },
			{ previewScale: 1 },
		]);
		expect(fixture.draws).toEqual([
			fixture.bitmaps[0],
			fixture.bitmaps[1],
			fixture.bitmaps[2],
			fixture.bitmaps[0],
			fixture.bitmaps[2],
		]);
	} finally {
		client.dispose();
		fixture.restore();
	}
});

test("leaving the page releases cached browsers and frames while back/forward cache preserves them", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	try {
		const input = {
			composition: composition(),
			timeSeconds: 1,
			target: fixture.target,
		};
		await client.renderTo(input);
		const cached = new Event("pagehide");
		Object.defineProperty(cached, "persisted", { value: true });
		fixture.browser.dispatchEvent(cached);
		await client.renderTo(input);
		expect(fixture.count("open")).toBe(1);
		expect(fixture.count("close")).toBe(0);
		fixture.browser.dispatchEvent(new Event("pagehide"));
		await expect(client.renderTo(input)).rejects.toThrow();
		expect(fixture.bitmaps[0].closed).toBe(true);
		expect(fixture.count("close")).toBe(1);
	} finally {
		client.dispose();
		fixture.restore();
	}
});

test("reuses decoded frames across cloned sources and fresh targets, with a 24-frame LRU", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	const draw = (timeSeconds: number) =>
		client.renderTo({
			composition: composition(),
			timeSeconds,
			target: { ...fixture.target },
		});
	try {
		await Promise.all([draw(0), draw(0), draw(0)]);
		expect(fixture.count("capture")).toBe(1);
		expect(fixture.draws).toEqual([
			fixture.bitmaps[0],
			fixture.bitmaps[0],
			fixture.bitmaps[0],
		]);
		for (let time = 1; time < 24; time++) await draw(time / 30);
		await draw(0);
		await draw(24 / 30);
		expect(fixture.bitmaps[0].closed).toBe(false);
		expect(fixture.bitmaps[1].closed).toBe(true);
		await draw(1 / 30);
		expect(fixture.count("capture")).toBe(26);
		expect(fixture.count("open")).toBe(1);
		expect(fixture.bitmaps.filter(({ closed }) => !closed)).toHaveLength(24);
	} finally {
		client.dispose();
		expect(fixture.bitmaps.every(({ closed }) => closed)).toBe(true);
		fixture.restore();
	}
});

test("bounds decoded bytes to 64 MiB and draws oversized frames without retaining them", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	const draw = (timeSeconds: number) =>
		client.renderTo({
			composition: composition(),
			timeSeconds,
			target: fixture.target,
		});
	try {
		Object.assign(fixture.dimensions, { width: 4096, height: 2160 });
		await draw(0);
		await draw(1);
		expect(fixture.bitmaps[0].closed).toBe(true);
		expect(fixture.bitmaps[1].closed).toBe(false);
		Object.assign(fixture.dimensions, { width: 8192, height: 4096 });
		await draw(2);
		await draw(2);
		expect(fixture.bitmaps.slice(2).every(({ closed }) => closed)).toBe(true);
		expect(fixture.count("capture")).toBe(4);
		await draw(1);
		expect(fixture.count("capture")).toBe(4);
	} finally {
		client.dispose();
		fixture.restore();
	}
});

test("closing during bitmap decode releases the result without drawing or caching it", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	let release!: () => void;
	let decoding!: () => void;
	const entered = new Promise<void>((resolve) => {
		decoding = resolve;
	});
	fixture.beforeDecode(() => {
		decoding();
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	try {
		const render = client.renderTo({
			composition: composition(),
			timeSeconds: 0,
			target: fixture.target,
		});
		await entered;
		client.dispose();
		release();
		await expect(render).rejects.toThrow();
		expect(fixture.draws).toHaveLength(0);
		expect(fixture.bitmaps).toHaveLength(1);
		expect(fixture.bitmaps[0].closed).toBe(true);
	} finally {
		client.dispose();
		fixture.restore();
	}
});
