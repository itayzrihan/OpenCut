import { describe, expect, test } from "bun:test";
import { createZipBlob, readZipEntries } from "../zip";
import { deflateRawSync } from "node:zlib";

async function deflatedFixture(text: string) {
	const stored = new Uint8Array(
		await (
			await createZipBlob({ entries: [{ path: "data", data: text }] })
		).arrayBuffer(),
	);
	const view = new DataView(stored.buffer);
	const directoryOffset = view.getUint32(stored.length - 6, true);
	const prefix = stored.slice(0, 34),
		tail = stored.slice(directoryOffset);
	const compressed = deflateRawSync(new TextEncoder().encode(text));
	const local = new DataView(prefix.buffer),
		central = new DataView(tail.buffer);
	local.setUint16(8, 8, true);
	local.setUint32(18, compressed.length, true);
	central.setUint16(10, 8, true);
	central.setUint32(20, compressed.length, true);
	central.setUint32(tail.length - 6, prefix.length + compressed.length, true);
	return { prefix, compressed, tail };
}

describe("project archive ZIP", () => {
	test("round-trips stored entries", async () => {
		const zip = await createZipBlob({
			entries: [
				{ path: "project.json", data: JSON.stringify({ name: "Demo" }) },
				{ path: "media/clip/clip.txt", data: "clip bytes" },
			],
		});

		const entries = await readZipEntries({ blob: zip });
		const projectEntry = entries.get("project.json");
		const clipEntry = entries.get("media/clip/clip.txt");

		if (!projectEntry || !clipEntry) {
			throw new Error("Expected ZIP entries to exist");
		}

		const projectJson = await projectEntry.json<{ name: string }>();
		expect(projectJson).toEqual({ name: "Demo" });
		expect(await clipEntry.text()).toBe("clip bytes");
	});

	test("rejects unsafe paths", async () => {
		await expect(
			createZipBlob({
				entries: [{ path: "../project.json", data: "{}" }],
			}),
		).rejects.toThrow("Invalid ZIP path");
	});

	test("reads and writes stored media in bounded slices without whole-file buffers", async () => {
		class SlicedBlob extends Blob {
			override arrayBuffer(): Promise<ArrayBuffer> {
				throw new Error("Whole-file read is forbidden");
			}
		}
		const original = new SlicedBlob([
			new Uint8Array(2 * 1024 * 1024 + 7).fill(123),
		]);
		const zip = await createZipBlob({
			entries: [{ path: "media/video", data: original }],
		});
		const read = await readZipEntries({ blob: new SlicedBlob([zip]) });
		expect(read.get("media/video")?.blob.size).toBe(original.size);
		expect(
			new Uint8Array(
				await read.get("media/video")!.blob.slice(-7).arrayBuffer(),
			),
		).toEqual(new Uint8Array(7).fill(123));
	});

	test("rejects duplicate paths on both export and hostile import", async () => {
		await expect(
			createZipBlob({
				entries: [
					{ path: "a", data: "a" },
					{ path: "a", data: "b" },
				],
			}),
		).rejects.toThrow("Duplicate");
		const data = new Uint8Array(
			await (
				await createZipBlob({
					entries: [
						{ path: "a", data: "a" },
						{ path: "b", data: "b" },
					],
				})
			).arrayBuffer(),
		);
		const view = new DataView(data.buffer),
			directory = view.getUint32(data.length - 6, true);
		data[32 + 30] = 97; // second local entry's one-byte path
		data[directory + 47 + 46] = 97;
		await expect(readZipEntries({ blob: new Blob([data]) })).rejects.toThrow(
			"Duplicate",
		);
	});

	test("validates header offsets and ZIP32 size before reading data", async () => {
		const data = new Uint8Array(
			await (
				await createZipBlob({ entries: [{ path: "a", data: "a" }] })
			).arrayBuffer(),
		);
		new DataView(data.buffer).setUint32(data.length - 6, 0xfffffff0, true);
		await expect(readZipEntries({ blob: new Blob([data]) })).rejects.toThrow(
			"bounds",
		);
		class OversizedBlob extends Blob {
			override get size() {
				return 0x100000000;
			}
		}
		await expect(readZipEntries({ blob: new OversizedBlob() })).rejects.toThrow(
			"metadata XML",
		);
	});

	test("accepts deflate and rejects declared or actual inflation bombs", async () => {
		const fixture = await deflatedFixture("repeated data ".repeat(10000));
		const packed = () =>
			new Blob([fixture.prefix, fixture.compressed, fixture.tail]);
		expect(
			await (await readZipEntries({ blob: packed() })).get("data")!.text(),
		).toBe("repeated data ".repeat(10000));
		new DataView(fixture.prefix.buffer).setUint32(22, 1, true);
		new DataView(fixture.tail.buffer).setUint32(24, 1, true);
		await expect(readZipEntries({ blob: packed() })).rejects.toThrow(
			"declared limit",
		);
		new DataView(fixture.prefix.buffer).setUint32(
			22,
			256 * 1024 * 1024 + 1,
			true,
		);
		new DataView(fixture.tail.buffer).setUint32(
			24,
			256 * 1024 * 1024 + 1,
			true,
		);
		await expect(readZipEntries({ blob: packed() })).rejects.toThrow(
			"expansion",
		);
	});
});
