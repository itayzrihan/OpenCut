import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime } from "./resolve";

export function getSourceSpanAtClipTime(
	options: Parameters<typeof getSourceTimeAtClipTime>[0],
): number {
	return Math.max(0, getSourceTimeAtClipTime(options));
}

export function splitRetimeAtClipTime({
	retime,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
} {
	return { left: retime, right: retime };
}

export function adjustRetimeForTrimChange({
	retime,
}: {
	retime?: RetimeConfig;
	clipTrimTime: number;
	side: "start" | "end";
}): RetimeConfig | undefined {
	return retime;
}
