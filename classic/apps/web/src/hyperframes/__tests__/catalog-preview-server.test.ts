// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadCatalogPreviewPackage } from "../catalog-preview-server";

test("live catalog IO verifies package bytes, limits and path confinement without rendering", async () => {
	const directory = await mkdtemp(join(tmpdir(), "catalog-preview-"));
	const text =
		'<!doctype html><div data-composition-id="test" data-duration="2">Live code</div>';
	const file = {
		path: "index.html",
		bytes: Buffer.byteLength(text),
		sha256: createHash("sha256").update(text).digest("hex"),
	};
	const plan = {
		sourcePath: "package",
		entryFile: "index.html",
		width: 1920,
		height: 1080,
		durationSeconds: 2,
		files: [file],
	};
	try {
		await mkdir(join(directory, "package"));
		await writeFile(join(directory, "package/index.html"), text);
		const result = await loadCatalogPreviewPackage({ input: plan, directory });
		expect(result.source.files["index.html"]).toBe(text);
		expect(result.html).toContain("opencut-catalog");
		expect(result.html).toContain("Live code");
		await expect(
			loadCatalogPreviewPackage({
				input: { ...plan, sourcePath: "../escape" },
				directory,
			}),
		).rejects.toThrow();
		await expect(
			loadCatalogPreviewPackage({
				input: { ...plan, files: [{ ...file, sha256: "0".repeat(64) }] },
				directory,
			}),
		).rejects.toThrow("integrity");
		await expect(
			loadCatalogPreviewPackage({
				input: { ...plan, files: [{ ...file, path: "../outside.html" }] },
				directory,
			}),
		).rejects.toThrow();
		await writeFile(join(directory, "outside.html"), text);
		await symlink(
			join(directory, "outside.html"),
			join(directory, "package/escape.html"),
		);
		await expect(
			loadCatalogPreviewPackage({
				input: {
					...plan,
					entryFile: "escape.html",
					files: [{ ...file, path: "escape.html" }],
				},
				directory,
			}),
		).rejects.toThrow("escaped");
		await writeFile(join(directory, "package/index.html"), text + "changed");
		await expect(
			loadCatalogPreviewPackage({ input: plan, directory }),
		).rejects.toThrow("integrity");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
