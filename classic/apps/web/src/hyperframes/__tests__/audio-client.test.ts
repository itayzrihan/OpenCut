import { expect, test } from "bun:test";
import { HyperframesRenderClient } from "../render-client";
import { HyperframesRenderCache } from "../render-cache";
import { composition, renderFixture } from "./render-client-fixture";
import type { TProject } from "@/project/types";
import { mediaTime } from "@/wasm";

test("derived audio is checked, deduplicated, bounded, retryable and invalidated with resource bindings", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const sha256 = [
		...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const artifact = {
		id: "audio",
		byteSize: bytes.length,
		sha256,
		mimeType: "audio/mp4",
	};
	let response: typeof artifact | null = artifact;
	const fixture = renderFixture({ audio: { bytes, artifact: () => response } });
	const client = new HyperframesRenderClient("project-a");
	const cache = new HyperframesRenderCache();
	try {
		const source = composition().source;
		const files = await Promise.all([
			client.readAudio(source),
			client.readAudio(structuredClone(source)),
		]);
		expect(files[0]).toBe(files[1]);
		expect(files[0]?.type).toBe("audio/mp4");
		expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(bytes);
		expect(fixture.count("audio")).toBe(1);
		response = null;
		expect(await client.readAudio(composition("silent").source)).toBeNull();
		expect(await client.readAudio(composition("silent").source)).toBeNull();
		expect(fixture.count("audio")).toBe(2);
		response = { ...artifact, sha256: "wrong" };
		await expect(client.readAudio(composition("retry").source)).rejects.toThrow(
			"checksum",
		);
		response = artifact;
		expect(await client.readAudio(composition("retry").source)).toBeInstanceOf(
			File,
		);
		for (let index = 0; index < 9; index++)
			await client.readAudio(composition(`source-${index}`).source);
		const count = fixture.count("audio");
		await client.readAudio(source); // old entry has been evicted
		expect(fixture.count("audio")).toBe(count + 1);
		client.dispose();
		await expect(client.readAudio(source)).rejects.toThrow();

		const project: Pick<TProject, "metadata" | "hyperframesCompositions"> = {
			metadata: {
				id: "project-a",
				name: "Audio",
				createdAt: new Date(),
				updatedAt: new Date(),
				duration: mediaTime({ ticks: 480000 }),
			},
			hyperframesCompositions: { main: composition() },
		};
		const asset = {
			id: "resource",
			name: "Resource",
			type: "audio" as const,
			file: new File(["original"], "source.mp3"),
		};
		cache.update({ project, mediaAssets: [asset] });
		const file = await cache.readAudio({ project, assetId: "main" });
		cache.update({ project: structuredClone(project), mediaAssets: [asset] });
		expect(await cache.readAudio({ project, assetId: "main" })).toBe(file);
		cache.update({
			project,
			mediaAssets: [{ ...asset, file: new File(["relinked"], "source.mp3") }],
		});
		expect(await cache.readAudio({ project, assetId: "main" })).not.toBe(file);
		await expect(
			cache.readAudio({
				project,
				assetId: "main",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		const pending = cache.readAudio({ project, assetId: "main" });
		cache.update({ project: null, mediaAssets: [] });
		await expect(pending).rejects.toThrow();
	} finally {
		client.dispose();
		cache.dispose();
		fixture.restore();
	}
});
