import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { inspectEncodedVideo } from "../video-inspection";

test("inspects actual exported WebM packets and audio tracks", async () => {
	const bytes = await readFile(
		new URL(
			"../../../../../../resources/hyperframes/evidence/composed-export/mixed-export.webm",
			import.meta.url,
		),
	);
	const result = await inspectEncodedVideo({
		buffer: Uint8Array.from(bytes).buffer,
		signal: new AbortController().signal,
	});
	expect(result.width).toBe(1920);
	expect(result.height).toBe(1080);
	expect(result.frameRate).toBeCloseTo(10);
	expect(result.packetCount).toBe(20);
	expect(result.audioTracks).toBe(1);
	// Video duration excludes Opus encoder padding at the container tail.
	expect(result.durationSeconds).toBeCloseTo(2);
});

test("rejects malformed video and an aborted inspection", async () => {
	await expect(
		inspectEncodedVideo({
			buffer: new ArrayBuffer(4),
			signal: new AbortController().signal,
		}),
	).rejects.toThrow();
	const controller = new AbortController();
	controller.abort();
	await expect(
		inspectEncodedVideo({
			buffer: new ArrayBuffer(4),
			signal: controller.signal,
		}),
	).rejects.toThrow();
});
