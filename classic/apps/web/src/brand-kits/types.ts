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
