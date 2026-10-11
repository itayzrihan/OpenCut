import { useContainerSize } from "@/hooks/use-container-size";
import { timelineTimeToSnappedPixels } from "@/timeline";
interface UseSnapIndicatorPositionParams {
	controlsWidth: number;
	snapPoint: { time: number } | null;
	zoomLevel: number;
	scrollLeft: number;
	timelineRef: React.RefObject<HTMLDivElement | null>;
}

interface SnapIndicatorPosition {
	leftPosition: number;
	topPosition: number;
	height: number;
}

export function useSnapIndicatorPosition({
	controlsWidth,
	snapPoint,
	zoomLevel,
	scrollLeft,
	timelineRef,
}: UseSnapIndicatorPositionParams): SnapIndicatorPosition {
	const { height: timelineHeight } = useContainerSize({
		containerRef: timelineRef,
	});
	const timelineContainerHeight = timelineHeight || 400;
	const totalHeight = timelineContainerHeight - 8; // 8px padding from edges

	const timelinePosition = timelineTimeToSnappedPixels({
		time: snapPoint?.time ?? 0,
		zoomLevel,
	});
	const leftPosition = controlsWidth + timelinePosition - scrollLeft;

	return {
		leftPosition,
		topPosition: 0,
		height: totalHeight,
	};
}
