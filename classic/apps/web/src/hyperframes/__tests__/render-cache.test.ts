import { expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import { mediaTime } from "@/wasm";
import { HyperframesRenderCache } from "../render-cache";
import { composition, renderFixture } from "./render-client-fixture";

function project(): Pick<TProject, "metadata" | "hyperframesCompositions"> {
	return {
		metadata: {
			id: "project-a",
			name: "Test",
			createdAt: new Date(),
			updatedAt: new Date(),
			duration: mediaTime({ ticks: 480000 }),
		},
		hyperframesCompositions: { main: composition() },
	};
}

test("layer inspection reuses the preview session and honors cancellation and scope", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	const current = project();
	try {
		cache.update({ project: current, mediaAssets: [] });
		await cache.getContext(current)!.renderTo({
			composition: current.hyperframesCompositions!.main,
			timeSeconds: 1,
			target: fixture.target,
		});
		const input = { project: current, assetId: "main" };
		const manifest = await cache.readManifest(input);
		expect(manifest.sourceFingerprint).toBe("fixture");
		manifest.diagnostics.push("local mutation");
		expect((await cache.readManifest(input)).diagnostics).toEqual([]);
		expect(fixture.count("open")).toBe(1);
		expect(fixture.count("close")).toBe(0);
		await expect(
			cache.readManifest({ ...input, signal: AbortSignal.abort() }),
		).rejects.toThrow();
		const pending = cache.readManifest(input);
		cache.update({ project: null, mediaAssets: [] });
		await expect(pending).rejects.toThrow();
		await expect(cache.readManifest(input)).rejects.toThrow();
	} finally {
		cache.dispose();
		fixture.restore();
	}
});

test("live delivery shares the capture session and rejects stale account, project and resource contexts", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	const current = project();
	try {
		cache.update({ project: current, mediaAssets: [] });
		const context = cache.getContext(current)!;
		const source = current.hyperframesCompositions!.main;
		await context.renderTo({
			composition: source,
			timeSeconds: 1,
			target: fixture.target,
		});
		const live = await context.openLivePreview!(source);
		expect(live.url).toContain("live-1.html");
		expect(fixture.count("open")).toBe(1);
		expect(fixture.calls.find((call) => call.action === "live")).toMatchObject({
			projectId: "project-a",
			account: "account-a",
			id: "1",
		});
		for (const name of ["two", "three", "four"]) {
			await context.renderTo({
				composition: composition(name),
				timeSeconds: 1,
				target: fixture.target,
			});
			expect(fixture.live.size).toBeLessThanOrEqual(2);
			expect(fixture.live.has("1")).toBe(true);
		}
		const currentLive = await context.openLivePreview!(source);
		expect(currentLive.url).toEqual(live.url);
		expect(fixture.count("open")).toBe(4);
		live.release?.(); // Releasing an older handle must not unpin its replacement.
		await context.renderTo({
			composition: composition("five"),
			timeSeconds: 1,
			target: fixture.target,
		});
		expect(fixture.live.has("1")).toBe(true);
		currentLive.release?.(); // Export/native-only preview can use both cache slots.
		await context.renderTo({
			composition: composition("six"),
			timeSeconds: 1,
			target: fixture.target,
		});
		expect(fixture.live.has("1")).toBe(false);
		cache.reset();
		await expect(context.openLivePreview!(source)).rejects.toThrow("previous");
		const fresh = cache.getContext(current)!;
		fixture.browser.__opencutAccountId = "account-b";
		await expect(fresh.openLivePreview!(source)).rejects.toThrow("previous");
		fixture.browser.__opencutAccountId = "account-a";
		const pending = fresh.openLivePreview!(source);
		cache.update({ project: null, mediaAssets: [] });
		await expect(pending).rejects.toThrow();
	} finally {
		cache.dispose();
		fixture.restore();
	}
});

test("canonical media republishing, loading, names and unrelated media keep frames and browsers warm", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	let current = project();
	let mediaAssets: MediaAsset[] = [
		{
			id: "resource",
			name: "Image",
			type: "image",
			url: "/image",
			file: new File(["png"], "image.png"),
		},
	];
	const sync = () => cache.update({ project: current, mediaAssets });
	const draw = () =>
		cache.getContext(current)!.renderTo({
			composition: current.hyperframesCompositions!.main,
			timeSeconds: 1,
			target: fixture.target,
		});
	try {
		sync();
		await draw();
		const revision = cache.revision;
		for (let edit = 0; edit < 20; edit++) {
			current = structuredClone(current);
			mediaAssets = mediaAssets.map((asset) => ({
				...asset,
				name: `Renamed ${edit}`,
				thumbnailUrl: `blob:${edit}`,
			}));
			expect(sync()).toBe(false);
			await draw();
		}
		mediaAssets.push({ id: "unrelated", name: "Other", type: "file" });
		expect(sync()).toBe(false);
		expect(sync()).toBe(false); // Loading state notification, same assets.
		const added = composition("second");
		added.source.resourceAssetIds = { "other.bin": "unrelated" };
		current.hyperframesCompositions!.second = added;
		expect(sync()).toBe(false); // Importing another source keeps this frame warm.
		await draw();
		expect(cache.revision).toBe(revision);
		expect(fixture.count("open")).toBe(1);
		expect(fixture.count("capture")).toBe(1);
		expect(fixture.count("close")).toBe(0);
		expect(fixture.draws).toHaveLength(22);
		// Relink may mutate an existing record. Compare copied values, not identity.
		mediaAssets[0].bindingRevision = 1;
		expect(sync()).toBe(true);
		expect(cache.revision).toBeGreaterThan(revision);
		expect(fixture.bitmaps[0].closed).toBe(true);
		await draw();
		expect(fixture.count("open")).toBe(2);
		expect(fixture.count("capture")).toBe(2);
	} finally {
		cache.dispose();
		fixture.restore();
	}
});

test("all bound byte handles invalidate frames, including missing/removal and restored sources", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	const current = project();
	const asset: MediaAsset = { id: "resource", name: "Image", type: "image" };
	let mediaAssets = [asset];
	const sync = () => cache.update({ project: current, mediaAssets });
	const draw = () =>
		cache.getContext(current)!.renderTo({
			composition: current.hyperframesCompositions!.main,
			timeSeconds: 1,
			target: fixture.target,
		});
	try {
		sync();
		await draw();
		const changes: Partial<MediaAsset>[] = [
			{ file: new File(["png"], "image.png") },
			{ url: "/new" },
			{ size: 3 },
			{ lastModified: 123 },
			{ fileName: "new.png" },
			{ mimeType: "image/png" },
			{ storageKind: "linked" },
			{ sourcePath: "C:/new.png" },
			{ missing: true },
			{ missing: false },
		];
		for (const change of changes) {
			Object.assign(asset, change);
			expect(sync()).toBe(true);
			await draw();
		}
		mediaAssets = [];
		expect(sync()).toBe(true);
		mediaAssets = [asset];
		expect(sync()).toBe(true);
		await draw();
		const sources = current.hyperframesCompositions;
		current.hyperframesCompositions = {};
		sync();
		asset.bindingRevision = 2;
		expect(sync()).toBe(true);
		current.hyperframesCompositions = sources;
		sync();
		await draw();
		expect(fixture.count("capture")).toBe(changes.length + 3);
	} finally {
		cache.dispose();
		fixture.restore();
	}
});

test("source edits use new frames, and previous project/account contexts cannot render", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	const current = project();
	const sync = () => cache.update({ project: current, mediaAssets: [] });
	const input = () => ({
		composition: current.hyperframesCompositions!.main,
		timeSeconds: 1,
		target: fixture.target,
	});
	try {
		sync();
		const oldContext = cache.getContext(current)!;
		await oldContext.renderTo(input());
		current.hyperframesCompositions = { main: composition("edited") };
		expect(sync()).toBe(false);
		await cache.getContext(current)!.renderTo(input());
		expect(fixture.count("capture")).toBe(2);
		current.metadata.id = "project-b";
		sync();
		current.metadata.id = "project-a";
		sync();
		await expect(oldContext.renderTo(input())).rejects.toThrow(
			"previous project",
		);
		const previousAccount = cache.getContext(current)!;
		fixture.browser.__opencutAccountId = "account-b";
		await expect(previousAccount.renderTo(input())).rejects.toThrow(
			"previous project or account",
		);
		sync();
		await cache.getContext(current)!.renderTo(input());
		expect(fixture.calls.at(-1)?.account).toBe("account-b");
		cache.dispose();
		await expect(
			cache.getContext(current)!.renderTo(input()),
		).rejects.toThrow();
	} finally {
		cache.dispose();
		fixture.restore();
	}
});
