import { expect, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { planHyperframesFolder, readHyperframesFolder } from "../folder";

function picked({ path, bytes }: { path: string; bytes: BlobPart[] }): File {
	const file = new File(bytes, path.split("/").at(-1)!, { lastModified: 100 });
	Object.defineProperty(file, "webkitRelativePath", {
		value: `Composition/${path}`,
	});
	return file;
}

test("real registry folder ingestion preserves BOM, Hebrew, CRLF and all binary bytes", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const html =
			'\uFEFF<!doctype html>\r\n<div data-composition-id="main" data-width="720" data-height="1280" data-duration="3">שלום</div>\r\n';
		const binary = new Uint8Array([0, 255, 127, 2, 0]);
		const files = [
			picked({ path: "index.html", bytes: [html] }),
			picked({ path: "assets/font.woff2", bytes: [binary] }),
			picked({ path: "dynamic/data.json", bytes: ['{"hello":"שלום"}'] }),
		];
		const folder = planHyperframesFolder({ files, runtime });
		const prepared = await readHyperframesFolder({ folder, runtime });
		expect(prepared.source.files["index.html"]).toBe(html);
		expect(prepared.source.files["dynamic/data.json"]).toContain("שלום");
		expect(prepared.inspection).toMatchObject({
			width: 720,
			height: 1280,
			durationSeconds: 3,
		});
		expect(prepared.resources[0]).toMatchObject({
			type: "file",
			mimeType: "font/woff2",
			size: 5,
		});
		expect(prepared.source.resourceAssetIds["assets/font.woff2"]).toBe(
			prepared.resources[0].id,
		);
		expect(
			new Uint8Array(await prepared.resources[0].file!.arrayBuffer()),
		).toEqual(binary);
	} finally {
		runtime.free();
	}
});

test("invalid UTF-8 and cancelled folder reads cannot produce an import", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const folder = planHyperframesFolder({
			files: [
				picked({ path: "index.html", bytes: [new Uint8Array([255, 255])] }),
			],
			runtime,
		});
		await expect(readHyperframesFolder({ folder, runtime })).rejects.toThrow(
			"UTF-8",
		);
		await expect(
			readHyperframesFolder({ folder, runtime, signal: AbortSignal.abort() }),
		).rejects.toThrow();
	} finally {
		runtime.free();
	}
});
