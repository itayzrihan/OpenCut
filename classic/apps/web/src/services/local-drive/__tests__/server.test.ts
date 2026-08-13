import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
});
