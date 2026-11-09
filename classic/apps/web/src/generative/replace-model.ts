export const REPLACE_VIDEO_MODEL = "alibaba/wan-3.0";
export const REPLACE_IMAGE_MODEL = "google/gemini-3.1-flash-image";
export const REPLACE_MAX_REFERENCES = 10;

export interface VideoGenerationModel {
	id: string;
	name?: string;
	supported_durations?: number[];
	supported_resolutions?: string[];
	supported_aspect_ratios?: string[];
	pricing_skus?: Record<string, string>;
}
