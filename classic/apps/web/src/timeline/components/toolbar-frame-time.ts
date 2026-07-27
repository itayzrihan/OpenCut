import type { FrameRate } from "opencut-wasm";
import { roundFrameTime, type MediaTime } from "@/wasm";

export function getToolbarFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): MediaTime {
	return roundFrameTime({ time, fps });
}
