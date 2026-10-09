import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { prepareHyperframesPreview } from "../preview-document";
import { HyperframesPreviewHost } from "../preview-host";
import type { HyperframesSource } from "../types";
import { parseHTMLContent } from "@hyperframes/core/compiler/html-document";

async function read({
	url,
	path,
	host,
	range,
	method = "GET",
}: {
	url: string;
	path?: string;
	host?: string;
	range?: string;
	method?: string;
}): Promise<{
	status: number;
	body: Buffer;
	headers: import("node:http").IncomingHttpHeaders;
}> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: "127.0.0.1",
				port: target.port,
				path: path ?? target.pathname,
				method,
				headers: { Host: host ?? target.host, ...(range && { Range: range }) },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode!,
						body: Buffer.concat(chunks),
						headers: res.headers,
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("official runtime and isolated host preserve nested source, dynamic fetches and media ranges", async () => {
	const runtime = await createCanonicalTestRuntime();
	const directory = await mkdtemp(join(tmpdir(), "opencut-preview-test-"));
	const host = new HyperframesPreviewHost();
	try {
		const binaryPath = join(directory, "voice.wav");
		await writeFile(binaryPath, new Uint8Array([1, 2, 3, 4, 5, 6]));
		const source: HyperframesSource = {
			entryFile: "index.html",
			files: {
				"index.html":
					'<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="4"><div data-composition-id="scene" data-composition-src="scenes/intro.html" data-start="0" data-duration="4"></div></main><script src="composition.js"></script></body></html>',
				"style.css": "body { margin: 0; background: transparent; }",
				"composition.js":
					'window.__timelines = {}; window.authorValue = "שלום"; fetch("/data/runtime.json");',
				"data/runtime.json": '{"caption":"From a runtime fetch"}',
				"scenes/intro.html":
					'<div data-composition-id="scene" data-duration="4"><span id="authored-text">Nested text</span><audio src="voice.wav" data-start="0" data-duration="4"></audio></div>',
			},
			resourceAssetIds: { "scenes/voice.wav": "voice-id" },
		};
		const compiled = prepareHyperframesPreview({ source, runtime });
		expect(compiled.html).toContain("scenes/intro.html");
		expect(compiled.html).toContain("composition.js");
		expect(source.files["index.html"]).not.toContain("integrity=");
		expect(compiled.html).toContain("__hyperframes");
		const preview = await host.add({
			...compiled,
			source,
			resources: new Map([
				[
					"outside-package.wav",
					{ path: binaryPath, mimeType: "audio/wav", size: 6 },
				],
				[
					"scenes/voice.wav",
					{ path: binaryPath, mimeType: "audio/wav", size: 6 },
				],
			]),
		});
		const page = await read({ url: preview.url });
		expect(page.status).toBe(200);
		expect(page.body.toString()).toBe(compiled.html);
		expect(page.headers["content-security-policy"]).toContain(
			"sandbox allow-scripts;",
		);
		expect(page.headers["content-security-policy"]).not.toContain(
			"allow-same-origin",
		);
		expect(page.headers["set-cookie"]).toBeUndefined();
		expect(
			(await read({ url: preview.url, path: "/outside-package.wav" })).status,
		).toBe(404);
		expect(
			(
				await read({ url: preview.url, path: "/scenes/intro.html" })
			).body.toString(),
		).toBe(source.files["scenes/intro.html"]);
		expect(
			(
				await read({ url: preview.url, path: "/data/runtime.json" })
			).body.toString(),
		).toContain("From a runtime fetch");
		const audio = await read({
			url: preview.url,
			path: "/scenes/voice.wav",
			range: "bytes=1-3",
		});
		expect(audio.status).toBe(206);
		expect([...audio.body]).toEqual([2, 3, 4]);
		expect(audio.headers["content-range"]).toBe("bytes 1-3/6");
		expect(
			(
				await read({
					url: preview.url,
					path: "/scenes/voice.wav",
					range: "bytes=-2",
				})
			).body,
		).toEqual(Buffer.from([5, 6]));
		expect(
			(
				await read({
					url: preview.url,
					path: "/scenes/voice.wav",
					range: "bytes=99-",
				})
			).status,
		).toBe(416);
		expect(
			(
				await read({
					url: preview.url,
					host: `localhost:${new URL(preview.url).port}`,
				})
			).status,
		).toBe(404);
		expect(
			(await read({ url: preview.url, path: "/../../outside" })).status,
		).toBe(404);
		expect((await read({ url: preview.url, method: "POST" })).status).toBe(405);
		host.remove({ id: preview.id });
		expect((await read({ url: preview.url })).status).toBe(404);
	} finally {
		runtime.free();
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("root scripts retain their head/body ordering and nested entries keep their original base URL", async () => {
	const runtime = await createCanonicalTestRuntime();
	const host = new HyperframesPreviewHost();
	try {
		const source: HyperframesSource = {
			entryFile: "scenes/entry.html",
			files: {
				"scenes/entry.html":
					'<!doctype html><html><head><script src="library.js"></script></head><body><div id="root" data-composition-id="main" data-width="640" data-height="360" data-duration="4"></div><script>window.plan={duration:4}</script><script src="composition.js"></script></body></html>',
				"scenes/library.js": "window.libraryReady = true;",
				"scenes/composition.js":
					"document.getElementById('root').dataset.duration = window.plan.duration; window.__timelines = {};",
			},
			resourceAssetIds: {},
		};
		const original = JSON.stringify(source);
		const compiled = prepareHyperframesPreview({ source, runtime });
		const document = parseHTMLContent(compiled.html);
		const headSources = [...document.head.querySelectorAll("script[src]")].map(
			(script) =>
				new URL(script.getAttribute("src")!, "http://preview.localhost/")
					.pathname,
		);
		expect(headSources).toContain("/library.js");
		expect(headSources).not.toContain("/composition.js");
		const bodyScript = document.body.querySelector("script[src]");
		expect(
			new URL(bodyScript!.getAttribute("src")!, "http://preview.localhost/")
				.pathname,
		).toBe("/composition.js");
		expect(JSON.stringify(source)).toBe(original);
		const preview = await host.add({
			...compiled,
			source,
			resources: new Map(),
		});
		expect(new URL(preview.url).pathname).toBe("/scenes/entry.html");
		expect(
			(
				await read({ url: preview.url, path: "/scenes/composition.js" })
			).body.toString(),
		).toBe(source.files["scenes/composition.js"]);
	} finally {
		runtime.free();
		await host.close();
	}
});

test("concurrent preview creation obeys the shared cache bound and close revokes access", async () => {
	const host = new HyperframesPreviewHost();
	const source: HyperframesSource = {
		entryFile: "index.html",
		files: {
			"index.html":
				"<div data-composition-id='main' data-duration='1' data-width='640' data-height='360'></div>",
		},
		resourceAssetIds: {},
	};
	const input = {
		html: source.files["index.html"],
		source,
		resources: new Map(),
	};
	try {
		const created = await Promise.allSettled(
			Array.from({ length: 9 }, () => host.add(input)),
		);
		expect(
			created.filter((result) => result.status === "fulfilled"),
		).toHaveLength(8);
		expect(
			created.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		await host.close();
		await expect(host.add(input)).rejects.toThrow("closed");
	} finally {
		await host.close();
	}
});
