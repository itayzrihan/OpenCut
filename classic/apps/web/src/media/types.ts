import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset extends Omit<
	MediaAssetData,
	"size" | "lastModified"
> {
	size?: number;
	lastModified?: number;
	file?: File;
	url?: string;
}
