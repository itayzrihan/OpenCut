import type {
	ElementAnimations,
	ScalarAnimationKey,
} from "@/animation/types";
import { PARALLAX_CAMERA_KEYFRAME_PATHS } from "./camera-keyframes";
import { generateUUID } from "@/utils/id";
import { mediaTime, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";

export interface CameraManSample {
	time: MediaTime;
	x: number;
	y: number;
	scale: number;
}

function sampleDistance({
	a,
	b,
}: {
	a: CameraManSample;
	b: CameraManSample;
}): number {
	return Math.hypot(
		b.x - a.x,
		b.y - a.y,
		Math.log(Math.max(0.05, b.scale) / Math.max(0.05, a.scale)),
	);
}

function distanceFromSegment({
	point,
	start,
	end,
}: {
	point: CameraManSample;
	start: CameraManSample;
	end: CameraManSample;
}): number {
	const duration = Math.max(1, end.time - start.time);
	const progress = Math.max(0, Math.min(1, (point.time - start.time) / duration));
	const expected: CameraManSample = {
		time: point.time,
		x: start.x + (end.x - start.x) * progress,
		y: start.y + (end.y - start.y) * progress,
		scale: start.scale + (end.scale - start.scale) * progress,
	};
	return sampleDistance({ a: point, b: expected });
}

export function easeCameraManSamples({
	samples,
	tolerance = 0.018,
}: {
	samples: CameraManSample[];
	tolerance?: number;
}): CameraManSample[] {
	if (samples.length <= 2) return samples.slice();
	const keep = new Set<number>([0, samples.length - 1]);

	const simplify = ({
		startIndex,
		endIndex,
	}: {
		startIndex: number;
		endIndex: number;
	}) => {
		let farthestIndex = -1;
		let farthestDistance = tolerance;
		for (let index = startIndex + 1; index < endIndex; index++) {
			const distance = distanceFromSegment({
				point: samples[index],
				start: samples[startIndex],
				end: samples[endIndex],
			});
			if (distance > farthestDistance) {
				farthestDistance = distance;
				farthestIndex = index;
			}
		}
		if (farthestIndex < 0) return;
		keep.add(farthestIndex);
		simplify({ startIndex, endIndex: farthestIndex });
		simplify({ startIndex: farthestIndex, endIndex });
	};

	simplify({ startIndex: 0, endIndex: samples.length - 1 });
	return [...keep].sort((a, b) => a - b).map((index) => samples[index]);
}

export function spreadCameraManSamples({
	samples,
	duration,
}: {
	samples: CameraManSample[];
	duration: MediaTime;
}): CameraManSample[] {
	if (samples.length === 0) return [];
	if (samples.length === 1) return [{ ...samples[0], time: ZERO_MEDIA_TIME }];
	const distances = [0];
	for (let index = 1; index < samples.length; index++) {
		distances.push(
			distances[index - 1] +
				sampleDistance({ a: samples[index - 1], b: samples[index] }),
		);
	}
	const total = distances.at(-1) ?? 0;
	return samples.map((sample, index) => ({
		...sample,
		time: mediaTime({
			ticks: Math.round(
				total > 0
					? (distances[index] / total) * duration
					: (index / (samples.length - 1)) * duration,
			),
		}),
	}));
}

function buildKeys({
	samples,
	value,
}: {
	samples: CameraManSample[];
	value: (sample: CameraManSample) => number;
}): ScalarAnimationKey[] {
	return samples.map((sample) => ({
		id: generateUUID(),
		time: sample.time,
		value: value(sample),
		segmentToNext: "bezier",
		tangentMode: "auto",
	}));
}

export function cameraManSamplesToAnimations({
	samples,
	baseAnimations,
}: {
	samples: CameraManSample[];
	baseAnimations?: ElementAnimations;
}): ElementAnimations {
	return {
		...(baseAnimations ?? {}),
		[PARALLAX_CAMERA_KEYFRAME_PATHS.x]: {
			keys: buildKeys({ samples, value: (sample) => sample.x }),
		},
		[PARALLAX_CAMERA_KEYFRAME_PATHS.y]: {
			keys: buildKeys({ samples, value: (sample) => sample.y }),
		},
		[PARALLAX_CAMERA_KEYFRAME_PATHS.scale]: {
			keys: buildKeys({ samples, value: (sample) => sample.scale }),
		},
	};
}
