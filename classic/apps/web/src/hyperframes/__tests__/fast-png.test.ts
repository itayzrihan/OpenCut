// @opencut-test-runner: node
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser doubles exercise encoder failures and cancellation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
	acquireBrowser,
	buildChromeArgs,
	releaseBrowser,
	type CaptureSession,
} from "@hyperframes/engine";
import { supportsLosslessFastPng } from "../fast-png";

async function fixture() {
	const pixels = Buffer.alloc(64 * 32 * 4);
	for (let alpha = 0; alpha < 256; alpha++)
		pixels.set([53, 149, 230, alpha], alpha * 4);
	const encode = (pixels: Buffer) =>
		sharp(pixels, { raw: { width: 64, height: 32, channels: 4 } })
			.png()
			.toBuffer();
	const baseline = await encode(pixels);
	let candidate = baseline;
	let closed = false;
	let opened = 0;
	const page = {
		setViewport: async () => {},
		setContent: async () => {},
		evaluate: async () => {},
		close: async () => {
			closed = true;
		},
		createCDPSession: async () => ({
			// eslint-disable-next-line opencut/prefer-object-params -- CDP's send method uses positional arguments.
			send: async (method: string, options: { optimizeForSpeed?: boolean }) =>
				method === "Page.captureScreenshot"
					? {
							data: (options.optimizeForSpeed ? candidate : baseline).toString(
								"base64",
							),
						}
					: {},
		}),
	};
	const browser = {
		newPage: async () => {
			opened++;
			return page;
		},
	};
	return {
		browser: browser as unknown as CaptureSession["browser"],
		page,
		pixels,
		encode,
		setCandidate: (bytes: Buffer) => {
			candidate = bytes;
		},
		isClosed: () => closed,
		opened: () => opened,
	};
}

test("fast PNG requires identical color and partial alpha, and always closes its probe", async () => {
	for (const mode of ["same", "color", "alpha", "invalid"] as const) {
		const testCase = await fixture();
		if (mode === "color") testCase.pixels[128 * 4]++;
		if (mode === "alpha") testCase.pixels[128 * 4 + 3] = 255;
		testCase.setCandidate(
			mode === "invalid"
				? Buffer.from("not a PNG")
				: await testCase.encode(testCase.pixels),
		);
		assert.equal(
			await supportsLosslessFastPng({ browser: testCase.browser }),
			mode === "same",
		);
		assert.equal(testCase.isClosed(), true);
	}
});

test("cancelled, unavailable and late probes retain the standard PNG encoder", async () => {
	const testCase = await fixture();
	assert.equal(
		await supportsLosslessFastPng({
			browser: testCase.browser,
			signal: AbortSignal.abort(),
		}),
		false,
	);
	assert.equal(testCase.opened(), 0);
	assert.equal(
		await supportsLosslessFastPng({
			browser: {
				newPage: async () => {
					throw new Error("Browser unavailable");
				},
			} as unknown as CaptureSession["browser"],
		}),
		false,
	);
	let resolvePage!: (value: typeof testCase.page) => void;
	const browser = {
		newPage: () =>
			new Promise<typeof testCase.page>((resolve) => {
				resolvePage = resolve;
			}),
	};
	const controller = new AbortController();
	const pending = supportsLosslessFastPng({
		browser: browser as unknown as CaptureSession["browser"],
		signal: controller.signal,
	});
	controller.abort();
	assert.equal(await pending, false);
	resolvePage(testCase.page);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(testCase.isClosed(), true);
});

test(
	"the bundled Chrome preserves the probe pixels with fast PNG and leaves no extra page",
	{
		skip: process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1",
		timeout: 30_000,
	},
	async () => {
		const { browser } = await acquireBrowser(
			buildChromeArgs(
				{ width: 320, height: 180, captureMode: "screenshot" },
				{ browserGpuMode: "software" },
			),
			{ enableBrowserPool: false },
		);
		try {
			const before = (await browser.pages()).length;
			assert.equal(await supportsLosslessFastPng({ browser }), true);
			assert.equal((await browser.pages()).length, before);
		} finally {
			await releaseBrowser(browser, { enableBrowserPool: false });
		}
	},
);
