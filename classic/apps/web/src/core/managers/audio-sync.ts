import type { RetimeConfig } from "@/timeline";

export type AudioOutputTimestamp = {
	contextTime?: number;
	performanceTime?: number;
};

export function getAudibleContextTime({
	contextTime,
	performanceTime,
	outputTimestamp,
	outputLatency,
}: {
	contextTime: number;
	performanceTime: number;
	outputTimestamp?: AudioOutputTimestamp;
	outputLatency: number;
}): number {
	const timestampContextTime = outputTimestamp?.contextTime;
	const timestampPerformanceTime = outputTimestamp?.performanceTime;
	if (
		typeof timestampContextTime === "number" &&
		Number.isFinite(timestampContextTime) &&
		timestampContextTime >= 0 &&
		typeof timestampPerformanceTime === "number" &&
		Number.isFinite(timestampPerformanceTime) &&
		timestampPerformanceTime > 0
	) {
		return (
			timestampContextTime + (performanceTime - timestampPerformanceTime) / 1000
		);
	}

	const safeOutputLatency =
		Number.isFinite(outputLatency) && outputLatency > 0 ? outputLatency : 0;
	return contextTime - safeOutputLatency;
}

export function getAudioContextStartTime({
	audibleContextTime,
	playbackTime,
	timelineTime,
	previewRate = 1,
}: {
	audibleContextTime: number;
	playbackTime: number;
	timelineTime: number;
	previewRate?: number;
}): number {
	return audibleContextTime + (timelineTime - playbackTime) / previewRate;
}

export function getAudioRecoveryTimelineTime({
	bufferTimelineTime,
	contextStartTime,
	currentContextTime,
	playbackTime,
	safetyMargin = 0.02,
	previewRate = 1,
}: {
	bufferTimelineTime: number;
	contextStartTime: number;
	currentContextTime: number;
	playbackTime: number;
	safetyMargin?: number;
	previewRate?: number;
}): number {
	const missedContextTime = Math.max(0, currentContextTime - contextStartTime);
	const safeMargin =
		Number.isFinite(safetyMargin) && safetyMargin > 0 ? safetyMargin : 0;

	return Math.max(
		playbackTime,
		bufferTimelineTime + (missedContextTime + safeMargin) * previewRate,
	);
}

export function getStreamingSourceDuration({
	bufferDuration,
	sourceOffset,
	playbackRate,
	bufferTimelineTime,
	clipEndTime,
	contextLateness,
	previewRate = 1,
}: {
	bufferDuration: number;
	sourceOffset: number;
	playbackRate: number;
	bufferTimelineTime: number;
	clipEndTime: number;
	contextLateness: number;
	previewRate?: number;
}): number {
	const remainingBufferDuration = Math.max(0, bufferDuration - sourceOffset);
	const remainingTimelineDuration = Math.max(
		0,
		clipEndTime - (bufferTimelineTime + contextLateness * previewRate),
	);
	const remainingSourceDuration = remainingTimelineDuration * playbackRate;

	return Math.min(remainingBufferDuration, remainingSourceDuration);
}

export function mapRetimeToTimelineScale({
	retime,
	timelineScale,
}: {
	retime?: RetimeConfig;
	timelineScale: number;
}): RetimeConfig | undefined {
	const safeTimelineScale =
		Number.isFinite(timelineScale) && timelineScale > 0 ? timelineScale : 1;
	const mappedRate = (retime?.rate ?? 1) * safeTimelineScale;

	if (!retime && Math.abs(mappedRate - 1) < 1e-6) {
		return undefined;
	}

	return {
		...retime,
		rate: mappedRate,
		...(retime?.speedKeyframes && {
			speedKeyframes: retime.speedKeyframes.map((key) => ({
				...key,
				rate: key.rate * safeTimelineScale,
			})),
		}),
	};
}
