const MAX_PREVIEW_RENDER_DIMENSION = 1600;
const MAX_PREVIEW_DEVICE_PIXEL_RATIO = 1.5;
const FALLBACK_PREVIEW_RENDER_DIMENSION = 1280;

export function getPreviewRenderSize({
	logicalWidth,
	logicalHeight,
	viewportWidth,
	viewportHeight,
	devicePixelRatio,
}: {
	logicalWidth: number;
	logicalHeight: number;
	viewportWidth: number;
	viewportHeight: number;
	devicePixelRatio: number;
}): { width: number; height: number; scale: number } {
	const safeLogicalWidth = Math.max(1, logicalWidth);
	const safeLogicalHeight = Math.max(1, logicalHeight);
	const maxLogicalDimension = Math.max(safeLogicalWidth, safeLogicalHeight);
	const maxDimensionScale =
		MAX_PREVIEW_RENDER_DIMENSION / maxLogicalDimension;
	const hasViewport = viewportWidth > 0 && viewportHeight > 0;
	const displayScale = hasViewport
		? Math.min(
				viewportWidth / safeLogicalWidth,
				viewportHeight / safeLogicalHeight,
			)
		: FALLBACK_PREVIEW_RENDER_DIMENSION / maxLogicalDimension;
	const pixelRatio = Math.max(
		1,
		Math.min(MAX_PREVIEW_DEVICE_PIXEL_RATIO, devicePixelRatio || 1),
	);
	const scale = Math.min(1, maxDimensionScale, displayScale * pixelRatio);

	return {
		width: Math.max(1, Math.round(safeLogicalWidth * scale)),
		height: Math.max(1, Math.round(safeLogicalHeight * scale)),
		scale,
	};
}
