import type {
	RetimeConfig,
	SpeedInterpolation,
	SpeedKeyframe,
} from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";

import { TICKS_PER_SECOND } from "@/wasm/media-time";

interface RetimeMapping {
	retime?: RetimeConfig;
	trimStart?: number;
	/** Set for exact-tick editor calls. Audio DSP works in seconds. */
	ticks?: boolean;
}

interface CurvePoint extends SpeedKeyframe {
	mappedTime: number;
}

const compiledCurves = new WeakMap<SpeedKeyframe[], CurvePoint[]>();

function easing({ mode, u }: { mode: SpeedInterpolation; u: number }) {
	switch (mode) {
		case "hold":
			return 0;
		case "linear":
			return u;
		case "easeIn":
			return u * u;
		case "easeOut":
			return u * (2 - u);
		case "easeInOut":
			return u * u * (3 - 2 * u);
	}
}

function integral({ mode, u }: { mode: SpeedInterpolation; u: number }) {
	switch (mode) {
		case "hold":
			return 0;
		case "linear":
			return (u * u) / 2;
		case "easeIn":
			return u ** 3 / 3;
		case "easeOut":
			return u * u - u ** 3 / 3;
		case "easeInOut":
			return u ** 3 * (1 - u / 2);
	}
}

// Integrate the speed over normalized playback time. Each segment's
// duration is its source width divided by its average playback speed.
function curvePoints(keyframes: SpeedKeyframe[]) {
	const existing = compiledCurves.get(keyframes);
	if (existing) return existing;
	const points: CurvePoint[] = [];
	for (const key of keyframes) {
		const left = points.at(-1);
		const mappedTime = left
			? left.mappedTime +
				(key.time - left.time) /
					(left.rate +
						(key.rate - left.rate) *
							integral({ mode: left.interpolation, u: 1 }))
			: key.time / key.rate;
		points.push({ ...key, mappedTime });
	}
	compiledCurves.set(keyframes, points);
	return points;
}

function sourceDistance({
	left,
	right,
	elapsed,
}: {
	left: CurvePoint;
	right: CurvePoint;
	elapsed: number;
}) {
	const width = right.mappedTime - left.mappedTime;
	return (
		elapsed * left.rate +
		width *
			(right.rate - left.rate) *
			integral({ mode: left.interpolation, u: elapsed / width })
	);
}

function segmentAt({
	points,
	time,
	coordinate,
}: {
	points: CurvePoint[];
	time: number;
	coordinate: "time" | "mappedTime";
}) {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const middle = (lo + hi) >>> 1;
		if (points[middle][coordinate] <= time) lo = middle + 1;
		else hi = middle;
	}
	return lo - 1;
}

function sourceAt({ points, time }: { points: CurvePoint[]; time: number }) {
	const index = segmentAt({ points, time, coordinate: "mappedTime" });
	const left = points[index] ?? points[0];
	const right = index < 0 ? undefined : points[index + 1];
	const elapsed = time - left.mappedTime;
	return (
		left.time +
		(right ? sourceDistance({ left, right, elapsed }) : elapsed * left.rate)
	);
}

function timelineAt({ points, time }: { points: CurvePoint[]; time: number }) {
	const index = segmentAt({ points, time, coordinate: "time" });
	const left = points[index] ?? points[0];
	const right = index < 0 ? undefined : points[index + 1];
	const elapsed = time - left.time;
	if (!right || left.rate === right.rate || left.interpolation === "hold") {
		return left.mappedTime + elapsed / left.rate;
	}
	if (elapsed === 0) return left.mappedTime;
	let lower = 0;
	let upper = right.mappedTime - left.mappedTime;
	const width = upper;
	const rateDelta = right.rate - left.rate;
	let position = (width * elapsed) / (right.time - left.time);
	for (let step = 0; step < 52; step++) {
		const error = sourceDistance({ left, right, elapsed: position }) - elapsed;
		if (Math.abs(error) < 1e-8) return left.mappedTime + position;
		if (error < 0) lower = position;
		else upper = position;
		const slope =
			left.rate +
			rateDelta * easing({ mode: left.interpolation, u: position / width });
		const next = position - error / slope;
		if (next === position) return left.mappedTime + position;
		position = next > lower && next < upper ? next : (lower + upper) / 2;
	}
	return left.mappedTime + position;
}

export function createRetimeMapping({
	retime,
	trimStart = 0,
	ticks = false,
}: RetimeMapping) {
	const rate = clampRetimeRate({ rate: retime?.rate ?? 1 });
	const keyframes = retime?.speedKeyframes;
	if (!keyframes?.length) {
		return {
			sourceAt: (clipTime: number) => clipTime * rate,
			clipAt: (sourceTime: number) => sourceTime / rate,
			rateAt: () => rate,
		};
	}
	const unit = ticks ? 1 : TICKS_PER_SECOND;
	const points = curvePoints(keyframes);
	const start = trimStart * unit;
	const origin = timelineAt({ points, time: start });
	return {
		sourceAt: (clipTime: number) =>
			(sourceAt({ points, time: origin + clipTime * unit }) - start) / unit,
		clipAt: (sourceTime: number) =>
			(timelineAt({ points, time: start + sourceTime * unit }) - origin) / unit,
		rateAt: (clipTime = 0) => {
			const time = origin + clipTime * unit;
			const index = segmentAt({ points, time, coordinate: "mappedTime" });
			const left = points[index] ?? points[0];
			const right = index < 0 ? undefined : points[index + 1];
			return right
				? left.rate +
						(right.rate - left.rate) *
							easing({
								mode: left.interpolation,
								u:
									(time - left.mappedTime) /
									(right.mappedTime - left.mappedTime),
							})
				: left.rate;
		},
	};
}

export function getSourceTimeAtClipTime({
	clipTime,
	...mapping
}: RetimeMapping & { clipTime: number }): number {
	return createRetimeMapping(mapping).sourceAt(clipTime);
}

export function getClipTimeAtSourceTime({
	sourceTime,
	...mapping
}: RetimeMapping & { sourceTime: number }): number {
	return createRetimeMapping(mapping).clipAt(sourceTime);
}

export function getEffectiveRateAt({
	clipTime,
	...mapping
}: RetimeMapping & { clipTime?: number }): number {
	return createRetimeMapping(mapping).rateAt(clipTime);
}

export function getTimelineDurationForSourceSpan({
	sourceSpan,
	...mapping
}: RetimeMapping & { sourceSpan: number }): number {
	return sourceSpan > 0 ? createRetimeMapping(mapping).clipAt(sourceSpan) : 0;
}
