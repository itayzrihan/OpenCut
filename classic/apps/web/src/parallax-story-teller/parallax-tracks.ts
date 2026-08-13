import type {
	ParallaxTrack,
	ParallaxTrackDirection,
	TimelineTrack,
} from "@/timeline/types";

export const PARALLAX_SPEED_MIN = 0;
export const PARALLAX_SPEED_MAX = 400;

export interface ParallaxTrackAssignment {
	markerTrackId: string;
	direction: ParallaxTrackDirection;
	speedPercent: number;
	motionFactor: number;
}

export function clampParallaxSpeed(speedPercent: number): number {
	if (!Number.isFinite(speedPercent)) return 0;
	return Math.max(
		PARALLAX_SPEED_MIN,
		Math.min(PARALLAX_SPEED_MAX, speedPercent),
	);
}

export function getParallaxMotionFactor({
	direction,
	speedPercent,
}: {
	direction: ParallaxTrackDirection;
	speedPercent: number;
}): number {
	const magnitude = clampParallaxSpeed(speedPercent) / 100;
	return direction === "with-camera" ? -magnitude : magnitude;
}

export function getParallaxWorldMotionFactor({
	assignment,
}: {
	assignment?: ParallaxTrackAssignment;
}): number {
	// A layer without a depth-plane marker is still pinned to the world, so it
	// must follow the camera crop at full strength. A marker replaces that base
	// relationship with its authored parallax rate.
	return assignment?.motionFactor ?? 1;
}

/**
 * Display order is top-to-bottom. A marker owns every following track until
 * the next marker. Tracks before the first marker keep the normal world-camera
 * relationship and receive no additional depth-plane assignment.
 */
export function resolveParallaxTrackAssignments({
	tracks,
}: {
	tracks: TimelineTrack[];
}): Map<string, ParallaxTrackAssignment> {
	const assignments = new Map<string, ParallaxTrackAssignment>();
	let marker: ParallaxTrack | null = null;

	for (const track of tracks) {
		if (track.type === "parallax") {
			marker = track;
			continue;
		}
		if (!marker || track.type === "audio") continue;

		const speedPercent = clampParallaxSpeed(marker.speedPercent);
		assignments.set(track.id, {
			markerTrackId: marker.id,
			direction: marker.direction,
			speedPercent,
			motionFactor: getParallaxMotionFactor({
				direction: marker.direction,
				speedPercent,
			}),
		});
	}

	return assignments;
}
