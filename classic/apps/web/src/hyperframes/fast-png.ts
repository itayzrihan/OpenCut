import sharp from "sharp";
import type { CaptureSession } from "@hyperframes/engine";

const PROBE_WIDTH = 64;
const PROBE_HEIGHT = 32;
const PROBE_TIMEOUT_MS = 2_000;

/** Chrome versions have differed in how the fast PNG encoder preserves alpha.
 * Compare decoded pixels on this browser before opting into the faster codec.
 * The probe owns a separate tiny page and never changes composition content. */
export async function supportsLosslessFastPng({
	browser,
	signal,
}: {
	browser: CaptureSession["browser"];
	signal?: AbortSignal;
}): Promise<boolean> {
	if (signal?.aborted) return false;
	let page: CaptureSession["page"] | undefined;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stop!: () => void;
	const closePage = () => page?.close().catch(() => {});
	const probe = async () => {
		try {
			page = await browser.newPage();
			if (stopped) return false;
			await page.setViewport({
				width: PROBE_WIDTH,
				height: PROBE_HEIGHT,
				deviceScaleFactor: 1,
			});
			// Four rows exercise every 8-bit alpha value with different RGB values.
			const pixels = Buffer.alloc(PROBE_WIDTH * 4 * 4);
			for (let alpha = 0; alpha < 256; alpha++) {
				pixels.set(
					[(alpha * 17) % 256, (alpha * 53) % 256, 255 - alpha, alpha],
					alpha * 4,
				);
			}
			const image = await sharp(pixels, {
				raw: { width: PROBE_WIDTH, height: 4, channels: 4 },
			})
				.png()
				.toBuffer();
			await page.setContent(
				`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}.paint{margin-top:8px;height:20px;background:linear-gradient(25deg,#e84a0022,#15aadecc);border-radius:7px;filter:blur(1px)}</style><img src="data:image/png;base64,${image.toString("base64")}"><div class="paint"></div>`,
			);
			await page.evaluate(async () => {
				await document.querySelector("img")?.decode();
			});
			const cdp = await page.createCDPSession();
			await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
				color: { r: 0, g: 0, b: 0, a: 0 },
			});
			const capture = async ({ fast }: { fast: boolean }) => {
				const result = await cdp.send("Page.captureScreenshot", {
					format: "png",
					fromSurface: true,
					captureBeyondViewport: false,
					optimizeForSpeed: fast,
					clip: {
						x: 0,
						y: 0,
						width: PROBE_WIDTH,
						height: PROBE_HEIGHT,
						scale: 1,
					},
				});
				return sharp(Buffer.from(result.data, "base64"), {
					limitInputPixels: PROBE_WIDTH * PROBE_HEIGHT,
				})
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
			};
			const baseline = await capture({ fast: false });
			const candidate = await capture({ fast: true });
			return (
				!stopped &&
				baseline.info.width === PROBE_WIDTH &&
				baseline.info.height === PROBE_HEIGHT &&
				candidate.info.width === PROBE_WIDTH &&
				candidate.info.height === PROBE_HEIGHT &&
				baseline.data[3] === 0 &&
				baseline.data[128 * 4 + 3] === 128 &&
				baseline.data[255 * 4 + 3] === 255 &&
				baseline.data.equals(candidate.data)
			);
		} catch {
			return false;
		} finally {
			await closePage();
		}
	};
	const cancelled = new Promise<false>((resolve) => {
		stop = () => {
			stopped = true;
			void closePage();
			resolve(false);
		};
		timer = setTimeout(stop, PROBE_TIMEOUT_MS);
		signal?.addEventListener("abort", stop, { once: true });
	});
	try {
		return await Promise.race([probe(), cancelled]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}
