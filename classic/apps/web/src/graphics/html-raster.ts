/**
 * Deterministic HTML-to-canvas rasterization for hyperframe graphic elements.
 *
 * A hyperframe is a self-contained HTML+CSS fragment rendered as video frames,
 * following the HyperFrames CSS adapter contract: all CSS animations are paused
 * and seeked to the frame time with a negative `animation-delay`. Per-element
 * stagger is expressed with the `--hf-delay` custom property instead of an
 * authored `animation-delay`. Scripts never run (SVG image rasterization), so
 * only CSS-driven motion is deterministic.
 */

const RASTER_CACHE_LIMIT = 180;
const RASTER_TIME_FPS = 30;

interface HyperframeRasterRequest {
	html: string;
	width: number;
	height: number;
	timeSeconds: number;
	durationSeconds: number;
}

interface RasterCacheEntry {
	canvas: OffscreenCanvas | HTMLCanvasElement;
}

const rasterCache = new Map<string, RasterCacheEntry>();
const pendingRasters = new Map<string, Promise<RasterCacheEntry | null>>();
const sanitizedHtmlCache = new Map<string, string>();

export function getHyperframeRasterTimeBucket({
	timeSeconds,
}: {
	timeSeconds: number;
}): number {
	return Math.round(timeSeconds * RASTER_TIME_FPS) / RASTER_TIME_FPS;
}

function buildRasterCacheKey({
	html,
	width,
	height,
	timeSeconds,
	durationSeconds,
}: HyperframeRasterRequest): string {
	return [
		hashString(html),
		Math.round(width),
		Math.round(height),
		getHyperframeRasterTimeBucket({ timeSeconds }),
		Math.round(durationSeconds * RASTER_TIME_FPS),
	].join(":");
}

/** Synchronous cache read used by the graphic definition's render(). */
export function getHyperframeRaster(
	request: HyperframeRasterRequest,
): OffscreenCanvas | HTMLCanvasElement | null {
	const entry = rasterCache.get(buildRasterCacheKey(request));
	return entry?.canvas ?? null;
}

/**
 * Awaitable rasterization used by the renderer resolve phase so preview and
 * export frames are never drawn before the raster is ready.
 */
export async function prepareHyperframeRaster(
	request: HyperframeRasterRequest,
): Promise<void> {
	const key = buildRasterCacheKey(request);
	if (rasterCache.has(key)) {
		return;
	}
	let pending = pendingRasters.get(key);
	if (!pending) {
		pending = rasterizeHyperframe(request)
			.then((entry) => {
				if (entry) {
					storeRasterEntry({ key, entry });
				}
				return entry;
			})
			.catch(() => null)
			.finally(() => {
				pendingRasters.delete(key);
			});
		pendingRasters.set(key, pending);
	}
	await pending;
}

function storeRasterEntry({
	key,
	entry,
}: {
	key: string;
	entry: RasterCacheEntry;
}): void {
	if (rasterCache.size >= RASTER_CACHE_LIMIT) {
		const oldestKey = rasterCache.keys().next().value;
		if (oldestKey !== undefined) {
			rasterCache.delete(oldestKey);
		}
	}
	rasterCache.set(key, entry);
}

async function rasterizeHyperframe(
	request: HyperframeRasterRequest,
): Promise<RasterCacheEntry | null> {
	if (typeof document === "undefined" || typeof Image === "undefined") {
		return null;
	}

	const svg = buildSeekedHyperframeSvg(request);
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	const image = new Image();
	image.decoding = "async";
	image.src = url;
	try {
		await image.decode();
	} catch {
		return null;
	}

	const width = Math.max(1, Math.round(request.width));
	const height = Math.max(1, Math.round(request.height));
	const canvas =
		typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(width, height)
			: buildDomCanvas({ width, height });
	const context = canvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!context) {
		return null;
	}
	context.clearRect(0, 0, width, height);
	context.drawImage(image, 0, 0, width, height);
	return { canvas };
}

function buildDomCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

export function buildSeekedHyperframeSvg({
	html,
	width,
	height,
	timeSeconds,
	durationSeconds,
}: HyperframeRasterRequest): string {
	const safeWidth = Math.max(1, Math.round(width));
	const safeHeight = Math.max(1, Math.round(height));
	const time = Math.max(0, timeSeconds);
	const duration = Math.max(0.001, durationSeconds);
	const progress = Math.min(1, Math.max(0, time / duration));
	const body = sanitizeHyperframeHtml({ html });
	const seekStyle = [
		"*, *::before, *::after {",
		"animation-play-state: paused !important;",
		`animation-delay: calc(var(--hf-delay, 0s) - ${time}s) !important;`,
		"animation-fill-mode: both !important;",
		"transition: none !important;",
		"caret-color: transparent !important;",
		"}",
	].join(" ");

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">`,
		`<foreignObject width="${safeWidth}" height="${safeHeight}">`,
		`<div xmlns="http://www.w3.org/1999/xhtml" style="width:${safeWidth}px;height:${safeHeight}px;overflow:hidden;position:relative;--hf-t:${time};--hf-progress:${progress};--hf-duration:${duration}">`,
		`<style>${escapeStyleContent({ css: seekStyle })}</style>`,
		body,
		"</div>",
		"</foreignObject>",
		"</svg>",
	].join("");
}

/**
 * Converts arbitrary (possibly malformed) HTML into well-formed, script-free
 * XHTML suitable for an SVG foreignObject. Head styles are preserved inline.
 */
export function sanitizeHyperframeHtml({ html }: { html: string }): string {
	const cached = sanitizedHtmlCache.get(html);
	if (cached !== undefined) {
		return cached;
	}
	if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
		return "";
	}

	const parsed = new DOMParser().parseFromString(html, "text/html");
	for (const node of [
		...parsed.querySelectorAll(
			"script, iframe, object, embed, link, meta, base, form, input, textarea, select, button, audio, video",
		),
	]) {
		node.remove();
	}
	for (const element of [...parsed.querySelectorAll("*")]) {
		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			const value = attribute.value.trim().toLowerCase();
			if (
				name.startsWith("on") ||
				((name === "href" || name === "src" || name === "xlink:href") &&
					value.startsWith("javascript:"))
			) {
				element.removeAttribute(attribute.name);
			}
		}
	}

	const container = parsed.createElement("div");
	for (const style of [...parsed.head.querySelectorAll("style")]) {
		container.appendChild(style);
	}
	while (parsed.body.firstChild) {
		container.appendChild(parsed.body.firstChild);
	}

	const serializer = new XMLSerializer();
	const serialized = [...container.childNodes]
		.map((node) => serializer.serializeToString(node))
		.join("");
	if (sanitizedHtmlCache.size >= 24) {
		const oldestKey = sanitizedHtmlCache.keys().next().value;
		if (oldestKey !== undefined) {
			sanitizedHtmlCache.delete(oldestKey);
		}
	}
	sanitizedHtmlCache.set(html, serialized);
	return serialized;
}

function escapeStyleContent({ css }: { css: string }): string {
	return css.replaceAll("<", "\\3c ");
}

function hashString(value: string): string {
	let hashA = 5381;
	let hashB = 52711;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		hashA = (hashA * 33) ^ code;
		hashB = (hashB * 31) ^ code;
	}
	return `${(hashA >>> 0).toString(36)}${(hashB >>> 0).toString(36)}:${value.length}`;
}
