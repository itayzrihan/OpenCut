import { accountScope } from "@/accounts/server";
// eslint-disable-next-line opencut/prefer-object-params -- Preserve Bun's test signature while adding account scope.
const test = (name: string, body: () => Promise<void>) =>
	runTest(name, () =>
		accountScope.run(
			{ id: "test-account", login: "test", displayName: "Test" },
			body,
		),
	);
import { describe, expect, mock, test as runTest } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
}));

describe("local-drive shared collections", () => {
	test("round-trips composition fonts and binary data through the project asset store", async () => {
		const { storeUploadedMedia, getMediaFile, listMedia } =
			await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "opencut-package-assets-"));
		const previous = process.env.OPENCUT_ACCOUNTS_DIR;
		process.env.OPENCUT_ACCOUNTS_DIR = directory;
		try {
			const bytes = new Uint8Array([0, 255, 32, 67, 0, 99]);
			for (const [id, fileName, mimeType] of [
				["font", "hebrew.woff2", "application/octet-stream"],
				["data", "module.wasm", "application/wasm"],
			]) {
				await storeUploadedMedia({
					projectId: "composition-project",
					mediaId: id,
					fileName,
					mimeType,
					lastModified: 100,
					size: bytes.byteLength,
					body: new Blob([bytes]).stream(),
					allowLargeCopy: false,
				});
				const file = await getMediaFile("composition-project", id);
				expect(file?.record.type).toBe("file");
				expect(new Uint8Array(await readFile(file!.path))).toEqual(bytes);
			}
			const records = await listMedia("composition-project");
			expect(records.find((asset) => asset.id === "font")).toMatchObject({
				type: "file",
				mimeType: "font/woff2",
				size: 6,
			});
			expect(records.find((asset) => asset.id === "data")).toMatchObject({
				type: "file",
				mimeType: "application/wasm",
			});
		} finally {
			if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
			else process.env.OPENCUT_ACCOUNTS_DIR = previous;
			await rm(directory, { recursive: true, force: true });
		}
	});
	test("indexes project metadata and only loads outdated migration candidates", async () => {
		const {
			getProjectThumbnail,
			listOutdatedProjects,
			listProjectMetadata,
			putProject,
		} = await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "pocut-project-index-"));
		const previousProjectsDirectory = process.env.OPENCUT_ACCOUNTS_DIR;
		process.env.OPENCUT_ACCOUNTS_DIR = directory;

		try {
			const embeddedThumbnail = `data:image/png;base64,${"AAECAw==".repeat(1024)}`;
			await putProject("current", {
				version: 33,
				metadata: {
					id: "current",
					name: "Current",
					createdAt: "2026-08-01T00:00:00.000Z",
					updatedAt: "2026-08-02T00:00:00.000Z",
					thumbnail: embeddedThumbnail,
				},
				scenes: [{ payload: "large editor state stays out of the index" }],
			});
			await putProject("outdated", {
				version: 32,
				metadata: {
					id: "outdated",
					name: "Outdated",
					createdAt: "2026-08-01T00:00:00.000Z",
					updatedAt: "2026-08-02T00:00:00.000Z",
				},
				scenes: [{ payload: "full state" }],
			});

			const metadata = await listProjectMetadata();
			expect(metadata).toHaveLength(2);
			expect(metadata).toContainEqual({
				id: "current",
				version: 33,
				metadata: expect.objectContaining({
					name: "Current",
					thumbnail: expect.stringContaining(
						"/api/local-drive/project-thumbnail?projectId=current",
					),
				}),
			});
			expect(metadata.every((project) => !("scenes" in project))).toBe(true);
			const storedProject = JSON.parse(
				await readFile(
					join(
						directory,
						"data",
						"test-account",
						"projects",
						"current",
						"project.json",
					),
					"utf8",
				),
			) as { metadata: { thumbnail?: string } };
			expect(storedProject.metadata.thumbnail).toStartWith(
				"/api/local-drive/project-thumbnail",
			);
			expect(JSON.stringify(storedProject)).not.toContain(embeddedThumbnail);
			expect(await getProjectThumbnail("current")).toMatchObject({
				mimeType: "image/png",
			});

			const outdated = await listOutdatedProjects(33);
			expect(outdated).toHaveLength(1);
			expect(outdated[0]).toMatchObject({ version: 32 });

			await putProject("outdated", {
				...(outdated[0] as Record<string, unknown>),
				version: 33,
			});
			expect(await listOutdatedProjects(33)).toEqual([]);
		} finally {
			if (previousProjectsDirectory === undefined) {
				delete process.env.OPENCUT_ACCOUNTS_DIR;
			} else {
				process.env.OPENCUT_ACCOUNTS_DIR = previousProjectsDirectory;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("stores generated UI elements", async () => {
		const { getSharedRecord, listSharedRecords, putSharedRecord } =
			await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "pocut-local-drive-"));
		const previousProjectsDirectory = process.env.OPENCUT_ACCOUNTS_DIR;
		process.env.OPENCUT_ACCOUNTS_DIR = directory;

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
				delete process.env.OPENCUT_ACCOUNTS_DIR;
			} else {
				process.env.OPENCUT_ACCOUNTS_DIR = previousProjectsDirectory;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("stores font metadata and bytes outside any project", async () => {
		const { getSharedFile, getSharedRecord, putSharedRecord, storeSharedFile } =
			await import("../server");
		const directory = await mkdtemp(join(tmpdir(), "pocut-shared-fonts-"));
		const previousProjectsDirectory = process.env.OPENCUT_ACCOUNTS_DIR;
		process.env.OPENCUT_ACCOUNTS_DIR = directory;

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
				delete process.env.OPENCUT_ACCOUNTS_DIR;
			} else {
				process.env.OPENCUT_ACCOUNTS_DIR = previousProjectsDirectory;
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
