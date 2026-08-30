export type VisualFitMode = "contain" | "cover";

export function resolveVisualFitScale({
	containerWidth,
	containerHeight,
	sourceWidth,
	sourceHeight,
	fitMode,
}: {
	containerWidth: number;
	containerHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	fitMode: VisualFitMode;
}): number {
	const widthScale = containerWidth / Math.max(1, sourceWidth);
	const heightScale = containerHeight / Math.max(1, sourceHeight);
	return fitMode === "cover"
		? Math.max(widthScale, heightScale)
		: Math.min(widthScale, heightScale);
}
