/** Match a derived capture to the preview's output pixels. Coarse upward
 * buckets avoid a new cached resolution for every animated scale value.
 * Layout and exported pixels always retain the original source dimensions.
 */
export function getHyperframesPreviewScale({
	sourceWidth,
	sourceHeight,
	logicalWidth,
	logicalHeight,
	outputWidth,
	outputHeight,
	scaleX,
	scaleY,
	preserveFullResolution = false,
}: {
	sourceWidth: number;
	sourceHeight: number;
	logicalWidth: number;
	logicalHeight: number;
	outputWidth: number;
	outputHeight: number;
	scaleX: number;
	scaleY: number;
	preserveFullResolution?: boolean;
}): number {
	if (preserveFullResolution) return 1;
	const fit = Math.min(
		logicalWidth / sourceWidth,
		logicalHeight / sourceHeight,
	);
	const output = Math.max(
		outputWidth / logicalWidth,
		outputHeight / logicalHeight,
	);
	const required = fit * output * Math.max(Math.abs(scaleX), Math.abs(scaleY));
	if (!Number.isFinite(required) || required >= 1) return 1;
	return [0.125, 0.25, 0.5, 1].find((scale) => scale >= required) ?? 1;
}
