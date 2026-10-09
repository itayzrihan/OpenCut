import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "opencut-proxy-cache-"));
let accountRoot = join(directory, "account-a");
const original = join(directory, "source.mp4");
await writeFile(original, "immutable original");
let complete!: () => void;
let jobsStarted = 0;
mock.module("@/accounts/server", () => ({
	accountDataRoot: () => accountRoot,
}));
mock.module("@/services/local-drive/server", () => ({
	getMediaFile: async () => ({
		path: original,
		stat: await stat(original),
		record: { mimeType: "video/mp4" },
	}),
}));
mock.module("../transcode", () => ({
	transcodePreview: async ({ destination }: { destination: string }) => {
		jobsStarted++;
		await new Promise<void>((resolve) => {
			complete = resolve;
		});
		await writeFile(destination, "derived preview");
		return { frames: 1, width: 1280, height: 720 };
	},
}));
const { prepareProxy, proxySource, proxyStatus } = await import("../server");
afterAll(() => rm(directory, { force: true, recursive: true }));

test("cache is account-scoped, deduplicates preparation, publishes only completed output, and invalidates changed sources", async () => {
	const a = await proxySource({ projectId: "project", mediaId: "media" });
	accountRoot = join(directory, "account-b");
	const b = await proxySource({ projectId: "project", mediaId: "media" });
	expect(a.path).not.toBe(b.path);
	expect(await proxyStatus(a)).toBe("missing");
	const results = await Promise.all([
		prepareProxy(a),
		prepareProxy(a),
		prepareProxy(b),
	]);
	expect(results).toEqual(["building", "building", "missing"]);
	expect(jobsStarted).toBe(1);
	expect(await proxyStatus(a)).toBe("building");
	complete();
	for (
		let attempt = 0;
		attempt < 100 && (await proxyStatus(a)) !== "ready";
		attempt++
	)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(await proxyStatus(a)).toBe("ready");
	expect(await proxyStatus(b)).toBe("missing");
	expect(await readFile(original, "utf8")).toBe("immutable original");
	await rm(a.marker);
	expect(await proxyStatus(a)).toBe("missing");
	await writeFile(original, "changed original, different size");
	expect(await a.unchanged()).toBe(false);
	accountRoot = join(directory, "account-a");
	expect(
		(await proxySource({ projectId: "project", mediaId: "media" })).key,
	).not.toBe(a.key);
});
