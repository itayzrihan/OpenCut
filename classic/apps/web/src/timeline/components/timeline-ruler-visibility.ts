const RULER_OVERSCAN_MIN_PX = 200;
const RULER_OVERSCAN_VIEWPORT_RATIO = 0.15;

export function getTimelineRulerVisibleTickRange({
	scrollLeft,
	viewportWidth,
	pixelsPerSecond,
	tickIntervalSeconds,
	tickCount,
}: {
	scrollLeft: number;
	viewportWidth: number;
	pixelsPerSecond: number;
	tickIntervalSeconds: number;
	tickCount: number;
}): { startTickIndex: number; endTickIndex: number } {
	if (
		tickCount <= 0 ||
		!Number.isFinite(scrollLeft) ||
		!Number.isFinite(viewportWidth) ||
		!Number.isFinite(pixelsPerSecond) ||
		!Number.isFinite(tickIntervalSeconds) ||
		pixelsPerSecond <= 0 ||
		tickIntervalSeconds <= 0
	) {
		return { startTickIndex: 0, endTickIndex: Math.max(0, tickCount - 1) };
	}

	const safeViewportWidth = Math.max(0, viewportWidth);
	const bufferPx = Math.max(
		RULER_OVERSCAN_MIN_PX,
		safeViewportWidth * RULER_OVERSCAN_VIEWPORT_RATIO,
	);

	const visibleStartTimeSeconds = Math.max(
		0,
		(scrollLeft - bufferPx) / pixelsPerSecond,
	);
	const visibleEndTimeSeconds =
		(scrollLeft + safeViewportWidth + bufferPx) / pixelsPerSecond;

	return {
		startTickIndex: Math.max(
			0,
			Math.floor(visibleStartTimeSeconds / tickIntervalSeconds),
		),
		endTickIndex: Math.min(
			tickCount - 1,
			Math.ceil(visibleEndTimeSeconds / tickIntervalSeconds),
		),
	};
}
