import type { ProjectFont, ProjectFontAsset } from "@/fonts/types";
import { loadDocumentFontSamples } from "@/fonts/font-loading";

const SUPPORTED_FONT_EXTENSIONS = new Map([
	["ttf", "font/ttf"],
	["otf", "font/otf"],
	["woff", "font/woff"],
	["woff2", "font/woff2"],
]);

const loadedFonts = new Map<string, string>();

export const CUSTOM_FONT_ACCEPT = ".ttf,.otf,.woff,.woff2";

export function getFontExtension({ fileName }: { fileName: string }): string {
	return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export function getSupportedFontMimeType({
	file,
}: {
	file: File;
}): string | null {
	const extension = getFontExtension({ fileName: file.name });
	return SUPPORTED_FONT_EXTENSIONS.get(extension) ?? null;
}

export function isSupportedFontFile({ file }: { file: File }): boolean {
	return getSupportedFontMimeType({ file }) !== null;
}

function normalizeFontFamilyName({ fileName }: { fileName: string }): string {
	const extension = getFontExtension({ fileName });
	const withoutExtension = extension
		? fileName.slice(0, -(extension.length + 1))
		: fileName;
	const family = withoutExtension
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return family || "Imported Font";
}

export function buildUniqueFontFamily({
	fileName,
	existingFamilies,
}: {
	fileName: string;
	existingFamilies: Iterable<string>;
}): string {
	const baseFamily = normalizeFontFamilyName({ fileName });
	const existing = new Set(
		Array.from(existingFamilies, (family) => family.toLowerCase()),
	);
	if (!existing.has(baseFamily.toLowerCase())) {
		return baseFamily;
	}

	let suffix = 2;
	while (existing.has(`${baseFamily} ${suffix}`.toLowerCase())) {
		suffix += 1;
	}
	return `${baseFamily} ${suffix}`;
}

export async function loadProjectFont({
	font,
}: {
	font: ProjectFont | ProjectFontAsset;
}): Promise<void> {
	const source = "url" in font && font.url ? font.url : font.sourceUrl;
	if (!source || typeof document === "undefined") return;

	if (loadedFonts.get(font.family) === source) return;

	const face = new FontFace(
		font.family,
		`url("${source.replace(/"/g, '\\"')}")`,
	);
	await face.load();
	document.fonts.add(face);
	loadedFonts.set(font.family, source);
	await loadDocumentFontSamples({
		font: `16px "${font.family.replace(/"/g, '\\"')}"`,
	});
}

export async function loadProjectFonts({
	fonts,
}: {
	fonts: Array<ProjectFont | ProjectFontAsset>;
}): Promise<void> {
	await Promise.all(fonts.map((font) => loadProjectFont({ font })));
}

export function isProjectFontLoaded({ family }: { family: string }): boolean {
	return loadedFonts.has(family);
}
