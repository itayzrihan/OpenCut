import type { MediaAssetData } from "@/services/storage/types";

/** Package files (fonts, shaders and binary data) use the same durable asset store. */
export type MediaType = "image" | "video" | "audio" | "file";

export interface MediaAsset extends Omit<
	MediaAssetData,
	"size" | "lastModified"
> {
	size?: number;
	lastModified?: number;
	file?: File;
	url?: string;
}
