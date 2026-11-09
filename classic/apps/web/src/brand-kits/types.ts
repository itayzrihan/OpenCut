export const BRAND_KITS_HREF = "/projects?tab=brand-kits";
export const MAX_BRAND_IMAGES = 64;
export const MAX_BRAND_IMAGE_TAGS = 12;
export const MAX_BRAND_IMAGE_TAG_BYTES = 96;
export const BRAND_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
];

export interface BrandImage {
	assetId: string;
	name: string;
	kind: "character" | "image";
	tags: string[];
}

/** JSON projection of opencut_account_core::brand_kit::BrandKit. */
export interface BrandKit {
	id: string;
	name: string;
	primaryColor: string;
	secondaryColor: string;
	backgroundColor: string;
	style: string;
	phrases: string[];
	headingFont: string;
	bodyFont: string;
	logo: { assetId: string; width: number; height: number } | null;
	images?: BrandImage[];
	musicIds: string[];
	sfxIds: string[];
}
export interface BrandKitLibrary {
	accountId: string;
	revision: number;
	kits: BrandKit[];
}
export function newBrandKit(): BrandKit {
	return {
		id: crypto.randomUUID(),
		name: "",
		primaryColor: "#ffffff",
		secondaryColor: "#b9ff66",
		backgroundColor: "#121512",
		style: "",
		phrases: [],
		headingFont: "Arial",
		bodyFont: "Arial",
		logo: null,
		musicIds: [],
		sfxIds: [],
	};
}
