import type { MediaAssetData } from "@/services/storage/types";
import type { ProjectFont } from "@/fonts/types";

export type MediaStorageKind = "copied" | "linked";

export interface LocalDriveStatus {
	rootPath: string;
	mediaLinkThresholdBytes: number;
}

export interface LocalDriveMediaRecord extends MediaAssetData {
	fileName: string;
	mimeType: string;
	storageKind: MediaStorageKind;
	sourcePath: string;
	missing?: boolean;
}

export interface StoredProjectFontRecord extends ProjectFont {
	url: string;
}

export type LocalDriveOperation =
	| "status"
	| "project.list"
	| "project.get"
	| "project.put"
	| "project.delete"
	| "history.get"
	| "history.put"
	| "history.delete"
	| "media.list"
	| "media.put"
	| "media.registerPath"
	| "media.pick"
	| "media.delete"
	| "media.clear"
	| "font.list"
	| "font.put"
	| "font.delete"
	| "font.clear"
	| "sounds.get"
	| "sounds.put"
	| "sounds.delete"
	| "shared.list"
	| "shared.get"
	| "shared.put"
	| "shared.delete"
	| "shared.clear"
	| "sharedFile.list"
	| "sharedFile.delete"
	| "sharedFile.clear"
	| "preferences.list"
	| "preferences.put"
	| "preferences.delete"
	| "all.clear";
