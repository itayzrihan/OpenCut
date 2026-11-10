/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Synthetic browser test export boundary. */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { acquireBrowser } from "@hyperframes/engine";
import { createCanvas } from "@napi-rs/canvas";

declare global {
	interface Window {
		__pdfFixture: typeof import("./storyboard-pdf-browser-fixture");
	}
}

test("real browser PDF renders Hebrew, complete sheets, scene images and continuation pages locally; account/revision/cancel never publish", async () => {
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("./storyboard-pdf-browser-fixture.ts", import.meta.url),
			),
		],
		target: "browser",
		format: "esm",
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const canvas = createCanvas(1200, 800),
		ctx = canvas.getContext("2d");
	ctx.fillStyle = "#eaf2f3";
	ctx.fillRect(0, 0, 1200, 800);
	for (let index = 0; index < 4; index++) {
		const x = 30 + (index % 2) * 590,
			y = 30 + Math.floor(index / 2) * 390;
		ctx.fillStyle = ["#315a6b", "#468b85", "#c59e72", "#a9bec7"][index];
		ctx.fillRect(x, y, 550, 340);
		ctx.fillStyle = "white";
		ctx.font = "bold 50px sans-serif";
		ctx.fillText(`SCENE ${index + 1}`, x + 50, y + 110);
		ctx.fillRect(x + 50, y + 170, 100 + index * 45, 85);
	}
	const png = canvas.toBuffer("image/png");
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/fixture.js")
				return new Response(bundle.outputs[0], {
					headers: { "Content-Type": "text/javascript" },
				});
			if (url.pathname === "/fonts/assistant/Assistant-Bold.ttf")
				return new Response(
					Bun.file(
						new URL(
							"../../public/fonts/assistant/Assistant-Bold.ttf",
							import.meta.url,
						),
					),
					{ headers: { "Content-Type": "font/ttf" } },
				);
			if (url.pathname === "/api/generative") {
				if (
					url.searchParams.get("projectId") !== "fixture-project" ||
					url.searchParams.get("file") !== "a".repeat(32) ||
					url.searchParams.get("account") !== "fixture-account" ||
					request.headers.get("X-OpenCut-Account") !== "fixture-account"
				)
					return new Response("scope mismatch", { status: 403 });
				return new Response(new Uint8Array(png), {
					headers: { "Content-Type": "image/png" },
				});
			}
			return new Response(
				"<!doctype html><html><body>Storyboard QA</body></html>",
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	try {
		const page = await lease.browser.newPage();
		await page.goto(`http://localhost:${server.port}`);
		await page.evaluate(async () => {
			const source = "/fixture.js";
			window.__pdfFixture = await import(source);
		});
		const success = await page.evaluate(() =>
			window.__pdfFixture.runPdfFixture("success"),
		);
		expect(success.result.type).toBe("success");
		expect(success.stored).toBe(1);
		if (success.result.type !== "success")
			throw new Error(success.result.message);
		expect(
			(success.result.data as { pageCount: number }).pageCount,
		).toBeGreaterThan(4);
		const pdf = Buffer.from(success.pdfBase64, "base64");
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		expect(pdf.length).toBeLessThan(15 * 1024 * 1024);
		if (process.env.POCUT_STORYBOARD_QA_DIR) {
			await mkdir(process.env.POCUT_STORYBOARD_QA_DIR, { recursive: true });
			await writeFile(
				`${process.env.POCUT_STORYBOARD_QA_DIR}/client-proposal-hebrew.pdf`,
				pdf,
			);
		}
		for (const mode of ["account", "revision", "cancel"] as const) {
			const result = await page.evaluate(
				(mode) => window.__pdfFixture.runPdfFixture(mode),
				mode,
			);
			expect(result.result.type).toBe("rejected");
			expect(result.stored).toBe(0);
			expect(result.pdfBase64).toBe("");
		}
		expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
		expect(
			requests
				.filter((request) => request.includes("/api/"))
				.every((request) => request === "GET /api/generative"),
		).toBe(true);
	} finally {
		server.stop();
		await lease.release();
	}
}, 60000);
