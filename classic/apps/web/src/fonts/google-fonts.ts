import type { FontAtlas } from "@/fonts/types";
import { loadDocumentFontSamples } from "@/fonts/font-loading";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import { loadTypekitFont, loadTypekitFonts } from "@/fonts/typekit-fonts";

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";
const FONT_ATLAS_PATH = "/fonts/font-atlas.json";
const FONT_CHUNK_PATH_PREFIX = "/fonts/font-chunk-";

const fullLoaded = new Set<string>();

let cachedAtlas: FontAtlas | null = null;
let atlasFetchPromise: Promise<FontAtlas | null> | null = null;

export interface GoogleFontVariant {
	style: "normal" | "italic";
	weight: number;
}

function encodeGoogleFontsFamily(family: string): string {
	return family.replace(/ /g, "+");
}

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

export function clearFontAtlasCache(): void {
	cachedAtlas = null;
	atlasFetchPromise = null;
	fullLoaded.clear();
}

export function loadFontAtlas(): Promise<FontAtlas | null> {
	if (cachedAtlas) return Promise.resolve(cachedAtlas);
	if (atlasFetchPromise) return atlasFetchPromise;

	atlasFetchPromise = fetch(FONT_ATLAS_PATH)
		.then(async (response) => {
			if (!response.ok) return null;
			const data: FontAtlas = await response.json();
			cachedAtlas = data;
			preloadChunkImages({ atlas: data });
			return data;
		})
		.catch(() => null);

	return atlasFetchPromise;
}

function preloadChunkImages({ atlas }: { atlas: FontAtlas }): void {
	const maxChunk = Math.max(
		...Object.values(atlas.fonts).map((entry) => entry.ch),
	);
	for (let i = 0; i <= maxChunk; i++) {
		// hint browser to preload chunk images without blocking
		const img = new Image();
		img.src = `${FONT_CHUNK_PATH_PREFIX}${i}.avif`;
	}
}

export function parseGoogleFontAtlasStyles({
	styles,
}: {
	styles: string[];
}): GoogleFontVariant[] {
	const variants = new Map<string, GoogleFontVariant>();

	for (const style of styles) {
		const match = style.match(/^(\d{3})(i?)$/);
		if (!match) continue;

		const weight = Number.parseInt(match[1], 10);
		if (!Number.isFinite(weight)) continue;

		const fontStyle = match[2] === "i" ? "italic" : "normal";
		variants.set(`${fontStyle}:${weight}`, { style: fontStyle, weight });
	}

	return [...variants.values()].sort(
		(left, right) =>
			left.weight - right.weight || left.style.localeCompare(right.style),
	);
}

export function getGoogleFontVariants({
	family,
	atlas = cachedAtlas,
}: {
	family: string;
	atlas?: FontAtlas | null;
}): GoogleFontVariant[] {
	const entry = atlas?.fonts[family];
	return entry ? parseGoogleFontAtlasStyles({ styles: entry.s }) : [];
}

function buildGoogleFontStylesheetUrl({
	family,
	variants,
}: {
	family: string;
	variants: GoogleFontVariant[];
}): string {
	const encodedFamily = encodeGoogleFontsFamily(family);
	const uniqueVariants = [...variants]
		.sort(
			(left, right) =>
				(left.style === "italic" ? 1 : 0) -
					(right.style === "italic" ? 1 : 0) || left.weight - right.weight,
		)
		.filter(
			(variant, index, sorted) =>
				index === 0 ||
				variant.style !== sorted[index - 1].style ||
				variant.weight !== sorted[index - 1].weight,
		);

	if (uniqueVariants.some((variant) => variant.style === "italic")) {
		const axisValues = uniqueVariants
			.map(
				(variant) => `${variant.style === "italic" ? 1 : 0},${variant.weight}`,
			)
			.join(";");
		return `${GOOGLE_FONTS_CSS}?family=${encodedFamily}:ital,wght@${axisValues}&display=swap`;
	}

	const weights = uniqueVariants.map((variant) => variant.weight).join(";");
	return `${GOOGLE_FONTS_CSS}?family=${encodedFamily}:wght@${weights}&display=swap`;
}

export async function loadFullFont({
	family,
	weights,
	variants,
}: {
	family: string;
	weights?: number[];
	variants?: GoogleFontVariant[];
}): Promise<void> {
	if (fullLoaded.has(family)) return;

	const atlas = cachedAtlas ?? (await loadFontAtlas());
	const variantsToLoad =
		variants && variants.length > 0
			? variants
			: getGoogleFontVariants({ family, atlas });
	const fallbackWeights = weights ?? [400, 700];
	const resolvedVariants =
		variantsToLoad.length > 0
			? variantsToLoad
			: fallbackWeights.map((weight) => ({ style: "normal" as const, weight }));
	const url = buildGoogleFontStylesheetUrl({
		family,
		variants: resolvedVariants,
	});
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = url;
	document.head.appendChild(link);
	await new Promise<void>((resolve) => {
		link.addEventListener("load", () => resolve(), { once: true });
		link.addEventListener("error", () => resolve(), { once: true });
	});
	await Promise.all(
		resolvedVariants.map((variant) =>
			loadDocumentFontSamples({
				font: `${variant.style} ${variant.weight} 16px "${family.replace(/"/g, '\\"')}"`,
			}),
		),
	);
	fullLoaded.add(family);
}

export async function loadFonts({
	families,
}: {
	families: string[];
}): Promise<void> {
	const nonSystemFonts = families.filter((family) => !SYSTEM_FONTS.has(family));
	if (nonSystemFonts.length === 0) return;

	const typekitFonts = await loadTypekitFonts();
	const typekitFontFamilies = new Set(typekitFonts.map((font) => font.family));

	await Promise.all(
		nonSystemFonts.map((family) =>
			typekitFontFamilies.has(family)
				? loadTypekitFont({ family })
				: loadFullFont({ family }),
		),
	);
}
