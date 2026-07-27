import type { ParamValues } from "@/params";
import type { CaptionLayoutSettings } from "@/subtitles/caption-layout";

export type SharedAudioFolder = "sfx" | "music";

export type SharedCategoryScope = "audio:sfx" | "audio:music" | "stickers";

export interface SharedAudioAsset {
	id: string;
	name: string;
	folder: SharedAudioFolder;
	mimeType: string;
	size: number;
	duration?: number;
	sourceUrl?: string;
	repositoryPath?: string;
	storageKind?: "repo" | "browser";
	fileName?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SharedStickerAsset {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	width?: number;
	height?: number;
	dataUrl?: string;
	sourceUrl?: string;
	repositoryPath?: string;
	storageKind?: "repo" | "browser";
	fileName?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SharedAssetCategory {
	id: string;
	scope: SharedCategoryScope;
	name: string;
	assetIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface GeneratedBackgroundPreset {
	id: string;
	name: string;
	description: string;
	params: ParamValues;
	createdAt: string;
	updatedAt: string;
}

export interface GeneratedEffectPreset {
	id: string;
	name: string;
	description: string;
	effectType: string;
	params: ParamValues;
	createdAt: string;
	updatedAt: string;
}

export interface SharedCaptionPreset {
	id: string;
	name: string;
	settings: CaptionLayoutSettings;
	createdAt: string;
	updatedAt: string;
}

export interface SharedLibraryManifest {
	version: 1;
	audioAssets: SharedAudioAsset[];
	stickerAssets: SharedStickerAsset[];
	categories: SharedAssetCategory[];
	generatedBackgrounds: GeneratedBackgroundPreset[];
	generatedEffects: GeneratedEffectPreset[];
	captionPresets: SharedCaptionPreset[];
	updatedAt: string;
}
