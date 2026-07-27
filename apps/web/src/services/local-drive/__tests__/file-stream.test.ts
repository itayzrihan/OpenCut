import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCancellationSafeFileStream } from "../file-stream";

const temporaryDirectories: string[] = [];

async function createTemporaryFile(contents: Uint8Array): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pocut-file-stream-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "media.bin");
	await writeFile(path, contents);
	return path;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("createCancellationSafeFileStream", () => {
	test("streams exactly the requested byte range", async () => {
		const path = await createTemporaryFile(
			new TextEncoder().encode("0123456789"),
		);
		const stream = createCancellationSafeFileStream({
			path,
			start: 2,
			end: 7,
			chunkBytes: 2,
		});

		expect(await new Response(stream).text()).toBe("234567");
	});

	test("closes cleanly when a media client cancels the response", async () => {
		const path = await createTemporaryFile(new Uint8Array(4 * 1024 * 1024));
		const reader = createCancellationSafeFileStream({
			path,
			start: 0,
			end: 4 * 1024 * 1024 - 1,
		}).getReader();

		const firstChunk = await reader.read();
		expect(firstChunk.done).toBe(false);
		await expect(reader.cancel()).resolves.toBeUndefined();
		expect(await reader.read()).toEqual({ done: true, value: undefined });
	});
});
