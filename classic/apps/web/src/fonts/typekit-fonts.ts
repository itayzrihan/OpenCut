import { loadDocumentFontSamples } from "@/fonts/font-loading";

export const TYPEKIT_STYLESHEET_URL = "https://use.typekit.net/rbg2gqg.css";

const TYPEKIT_STYLE_ELEMENT_ID = "opencut-typekit-rbg2gqg";
const DEFAULT_TYPEKIT_WEIGHTS = [400, 700];

export interface TypekitFontVariant {
	style: string;
	weight: number;
	sourceUrl?: string;
}

export interface TypekitFontMeta {
	family: string;
	styles: string[];
	weights: number[];
	variants: TypekitFontVariant[];
}

let cachedFonts: TypekitFontMeta[] | null = null;
let fontFetchPromise: Promise<TypekitFontMeta[]> | null = null;
const loadedFamilySignatures = new Map<string, string>();

export function parseTypekitFontsFromCss({
	css,
}: {
	css: string;
}): TypekitFontMeta[] {
	const fontsByFamily = new Map<
		string,
		{
			styles: Set<string>;
			variants: Map<string, TypekitFontVariant>;
			weights: Set<number>;
		}
	>();
	const fontFaceRegex = /@font-face\s*{([\s\S]*?)}/g;
	let match: RegExpExecArray | null;

	while ((match = fontFaceRegex.exec(css))) {
		const block = match[1] ?? "";
		const family = matchCssStringProperty({ block, property: "font-family" });
		if (!family) continue;

		const style =
			matchCssTokenProperty({ block, property: "font-style" }) ?? "normal";
		const weight = parseCssFontWeight({
			value: matchCssTokenProperty({ block, property: "font-weight" }),
		});
		const sourceUrl = matchPreferredFontSource({ block });
		const entry = fontsByFamily.get(family) ?? {
			styles: new Set<string>(),
			variants: new Map<string, TypekitFontVariant>(),
			weights: new Set<number>(),
		};
		entry.styles.add(style);
		if (weight !== null) {
			entry.weights.add(weight);
			entry.variants.set(`${style}:${weight}`, {
				style,
				weight,
				...(sourceUrl ? { sourceUrl } : {}),
			});
		}
		fontsByFamily.set(family, entry);
	}

	return [...fontsByFamily.entries()]
		.map(([family, entry]) => ({
			family,
			styles: [...entry.styles].sort(),
			weights: [...entry.weights].sort((left, right) => left - right),
			variants: [...entry.variants.values()].sort(
				(left, right) =>
					left.weight - right.weight || left.style.localeCompare(right.style),
			),
		}))
		.sort((left, right) => left.family.localeCompare(right.family));
}

export function getCachedTypekitFonts(): TypekitFontMeta[] | null {
	return cachedFonts;
}

export async function loadTypekitFonts({
	refresh = false,
}: {
	refresh?: boolean;
} = {}): Promise<TypekitFontMeta[]> {
	if (!refresh && cachedFonts) return cachedFonts;
	if (!refresh && fontFetchPromise) return fontFetchPromise;

	fontFetchPromise = fetch(TYPEKIT_STYLESHEET_URL, { cache: "no-store" })
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`Typekit CSS failed: ${response.status}`);
			}
			const css = await response.text();
			injectTypekitCss({ css });
			const fonts = parseTypekitFontsFromCss({ css });
			cachedFonts = fonts;
			return fonts;
		})
		.catch(() => {
			ensureTypekitLink();
			return cachedFonts ?? [];
		})
		.finally(() => {
			fontFetchPromise = null;
		});

	return fontFetchPromise;
}

export async function isTypekitFontFamily({
	family,
}: {
	family: string;
}): Promise<boolean> {
	const fonts = await loadTypekitFonts();
	return fonts.some((font) => font.family === family);
}

export async function loadTypekitFont({
	family,
}: {
	family: string;
}): Promise<boolean> {
	const fonts = await loadTypekitFonts();
	const meta = fonts.find((font) => font.family === family);
	if (!meta) return false;
	if (typeof document === "undefined") return true;

	const variants: TypekitFontVariant[] =
		meta.variants.length > 0
			? meta.variants
			: DEFAULT_TYPEKIT_WEIGHTS.map((weight) => ({ style: "normal", weight }));
	const signature = variants
		.map((variant) => `${variant.style}:${variant.weight}:${variant.sourceUrl ?? "stylesheet"}`)
		.join("|");
	if (loadedFamilySignatures.get(family) === signature) return true;

	const escapedFamily = family.replace(/"/g, '\\"');
	const results = await Promise.all(
		variants.map(async (variant) => {
			if (variant.sourceUrl && typeof FontFace !== "undefined") {
				try {
					const face = new FontFace(
						family,
						`url("${variant.sourceUrl.replace(/"/g, "%22")}")`,
						{ style: variant.style, weight: String(variant.weight) },
					);
					const loadedFace = await face.load();
					document.fonts.add(loadedFace);
					return true;
				} catch {
					// Fall through to the stylesheet-backed loader.
				}
			}
			const loaded = await loadDocumentFontSamples({
				font: `${variant.style} ${variant.weight} 16px "${escapedFamily}"`,
			}).catch(() => false);
			return loaded;
		}),
	);
	if (!results.some(Boolean)) return false;
	loadedFamilySignatures.set(family, signature);
	return true;
}

function matchPreferredFontSource({ block }: { block: string }): string | undefined {
	const sources = [...block.matchAll(/url\(["']?([^"')]+)["']?\)\s*format\(["']([^"']+)["']\)/gi)];
	const preferred =
		sources.find((match) => match[2]?.toLowerCase() === "woff2") ?? sources[0];
	return preferred?.[1];
}

function injectTypekitCss({ css }: { css: string }): void {
	if (typeof document === "undefined") return;

	let styleElement = document.getElementById(TYPEKIT_STYLE_ELEMENT_ID);
	if (!styleElement) {
		styleElement = document.createElement("style");
		styleElement.id = TYPEKIT_STYLE_ELEMENT_ID;
		document.head.appendChild(styleElement);
	}
	if (styleElement.textContent !== css) {
		styleElement.textContent = css;
	}
}

function ensureTypekitLink(): void {
	if (typeof document === "undefined") return;
	if (
		document.querySelector(
			`link[rel="stylesheet"][href="${TYPEKIT_STYLESHEET_URL}"]`,
		)
	) {
		return;
	}

	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = TYPEKIT_STYLESHEET_URL;
	document.head.appendChild(link);
}

function matchCssStringProperty({
	block,
	property,
}: {
	block: string;
	property: string;
}): string | null {
	const escapedProperty = escapeRegExp(property);
	const match = block.match(
		new RegExp(`${escapedProperty}\\s*:\\s*["']([^"']+)["']`, "i"),
	);
	return match?.[1] ?? null;
}

function matchCssTokenProperty({
	block,
	property,
}: {
	block: string;
	property: string;
}): string | null {
	const escapedProperty = escapeRegExp(property);
	const match = block.match(
		new RegExp(`${escapedProperty}\\s*:\\s*([^;\\s]+)`, "i"),
	);
	return match?.[1] ?? null;
}

function parseCssFontWeight({
	value,
}: {
	value: string | null;
}): number | null {
	if (!value) return null;
	if (value === "normal") return 400;
	if (value === "bold") return 700;

	const numeric = Number.parseInt(value, 10);
	return Number.isFinite(numeric) ? numeric : null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
