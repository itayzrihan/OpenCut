export const seamlessModelIds = [
	"alibaba/wan-3.0",
	"alibaba/wan-3.0-prime",
	"alibaba/wan-2.7",
	"bytedance/seedance-2.5",
	"bytedance/seedance-2.0",
] as const;

export interface VideoGenerationModel {
	id: string;
	name?: string;
	supported_durations?: number[];
	supported_resolutions?: string[];
	supported_aspect_ratios?: string[];
	supported_frame_images?: string[];
	generate_audio?: boolean;
	pricing_skus?: Record<string, string>;
}

export function seamlessDurations(model?: VideoGenerationModel) {
	return (model?.supported_durations ?? [])
		.filter((value) => Number.isInteger(value) && value >= 1 && value <= 30)
		.sort((a, b) => a - b);
}

export function supportsSeamless(model: VideoGenerationModel) {
	return (
		seamlessModelIds.some((id) => id === model.id) &&
		["first_frame", "last_frame"].every((frame) =>
			model.supported_frame_images?.includes(frame),
		) &&
		seamlessDurations(model).length > 0
	);
}
