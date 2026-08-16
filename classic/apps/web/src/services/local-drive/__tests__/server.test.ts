import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
}));

describe("local-drive shared collections", () => {
	test("stores generated UI elements", async () => {
		const { getSharedRecord, listSharedRecords, putSharedRecord } =
			await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "pocut-local-drive-"));
		const previousProjectsDirectory = process.env.POCUT_PROJECTS_DIR;
		process.env.POCUT_PROJECTS_DIR = directory;

		try {
			expect(await listSharedRecords("ui-elements")).toEqual([]);

			await putSharedRecord("ui-elements", "button", {
				id: "ignored",
				name: "Button",
			});

			expect(await getSharedRecord("ui-elements", "button")).toEqual({
				id: "button",
				name: "Button",
			});
		} finally {
			if (previousProjectsDirectory === undefined) {
				delete process.env.POCUT_PROJECTS_DIR;
			} else {
				process.env.POCUT_PROJECTS_DIR = previousProjectsDirectory;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("stores font metadata and bytes outside any project", async () => {
		const { getSharedFile, getSharedRecord, putSharedRecord, storeSharedFile } =
			await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "pocut-shared-fonts-"));
		const previousProjectsDirectory = process.env.POCUT_PROJECTS_DIR;
		process.env.POCUT_PROJECTS_DIR = directory;

		try {
			const bytes = new Uint8Array([0, 1, 0, 0, 102, 111, 110, 116]);
			await storeSharedFile({
				kind: "fonts",
				id: "font-1",
				body: new Blob([bytes]).stream(),
			});
			await putSharedRecord("fonts", "font-1", {
				family: "Shared Font",
				fileName: "shared.ttf",
				mimeType: "font/ttf",
				size: bytes.byteLength,
				lastModified: 1,
				createdAt: "2026-08-16T00:00:00.000Z",
			});

			const storedFile = await getSharedFile("fonts", "font-1");
			expect(storedFile).not.toBeNull();
			expect(new Uint8Array(await readFile(storedFile!.path))).toEqual(bytes);
			expect(await getSharedRecord("fonts", "font-1")).toMatchObject({
				id: "font-1",
				family: "Shared Font",
				fileName: "shared.ttf",
			});
		} finally {
			if (previousProjectsDirectory === undefined) {
				delete process.env.POCUT_PROJECTS_DIR;
			} else {
				process.env.POCUT_PROJECTS_DIR = previousProjectsDirectory;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
