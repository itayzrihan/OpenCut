// Reference-only pre-migration geometry, compared against canonical Rust/WASM edits.
import { generateUUID } from "@/utils/id";
import type { ElementBounds } from "@/preview/element-bounds";
import type { FreeformPathMaskParams } from "@/masks/types";
import {
	getFreeformSegmentCount,
	getFreeformCanvasSegments,
	recenterFreeformPath,
	type CanvasPoint,
	type FreeformPathPoint,
} from "@/masks/freeform/path";

const HANDLE_EPSILON = 1e-9;

function isZeroHandle({ x, y }: { x: number; y: number }): boolean {
	return Math.abs(x) <= HANDLE_EPSILON && Math.abs(y) <= HANDLE_EPSILON;
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function getDistanceSquared({
	a,
	b,
}: {
	a: CanvasPoint;
	b: CanvasPoint;
}): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function lerpPoint({
	a,
	b,
	t,
}: {
	a: CanvasPoint;
	b: CanvasPoint;
	t: number;
}): CanvasPoint {
	return {
		x: a.x + (b.x - a.x) * t,
		y: a.y + (b.y - a.y) * t,
	};
}

function evaluateCubicBezier({
	p0,
	p1,
	p2,
	p3,
	t,
}: {
	p0: CanvasPoint;
	p1: CanvasPoint;
	p2: CanvasPoint;
	p3: CanvasPoint;
	t: number;
}): CanvasPoint {
	const oneMinusT = 1 - t;
	return {
		x:
			oneMinusT ** 3 * p0.x +
			3 * oneMinusT ** 2 * t * p1.x +
			3 * oneMinusT * t ** 2 * p2.x +
			t ** 3 * p3.x,
		y:
			oneMinusT ** 3 * p0.y +
			3 * oneMinusT ** 2 * t * p1.y +
			3 * oneMinusT * t ** 2 * p2.y +
			t ** 3 * p3.y,
	};
}

function getFreeformSegmentIndices({
	points,
	segmentIndex,
	closed,
}: {
	points: FreeformPathPoint[];
	segmentIndex: number;
	closed: boolean;
}): { startIndex: number; endIndex: number } | null {
	const segmentCount = getFreeformSegmentCount({ points, closed });
	if (segmentIndex < 0 || segmentIndex >= segmentCount) {
		return null;
	}

	return {
		startIndex: segmentIndex,
		endIndex: (segmentIndex + 1) % points.length,
	};
}

export function findClosestPointOnFreeformSegment({
	points,
	segmentIndex,
	canvasPoint,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
	closed,
}: {
	points: FreeformPathPoint[];
	segmentIndex: number;
	canvasPoint: CanvasPoint;
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
	closed: boolean;
}): { t: number; point: CanvasPoint } | null {
	const segment = getFreeformCanvasSegments({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
		closed,
	}).find((candidate) => candidate.index === segmentIndex);
	if (!segment) {
		return null;
	}

	const sampleCount = 24;
	let bestT = 0;
	let bestDistanceSquared = getDistanceSquared({
		a: canvasPoint,
		b: segment.start,
	});

	for (let step = 0; step <= sampleCount; step++) {
		const t = step / sampleCount;
		const point = evaluateCubicBezier({
			p0: segment.start,
			p1: segment.startOut,
			p2: segment.endIn,
			p3: segment.end,
			t,
		});
		const distanceSquared = getDistanceSquared({ a: canvasPoint, b: point });
		if (distanceSquared < bestDistanceSquared) {
			bestDistanceSquared = distanceSquared;
			bestT = t;
		}
	}

	let searchStep = 1 / sampleCount;
	for (let iteration = 0; iteration < 8; iteration++) {
		const candidates = [bestT - searchStep, bestT, bestT + searchStep]
			.map(clampUnit)
			.map((t) => ({
				t,
				point: evaluateCubicBezier({
					p0: segment.start,
					p1: segment.startOut,
					p2: segment.endIn,
					p3: segment.end,
					t,
				}),
			}));
		for (const candidate of candidates) {
			const distanceSquared = getDistanceSquared({
				a: canvasPoint,
				b: candidate.point,
			});
			if (distanceSquared < bestDistanceSquared) {
				bestDistanceSquared = distanceSquared;
				bestT = candidate.t;
			}
		}
		searchStep /= 2;
	}

	const clampedT = Math.min(0.999, Math.max(0.001, bestT));
	return {
		t: clampedT,
		point: evaluateCubicBezier({
			p0: segment.start,
			p1: segment.startOut,
			p2: segment.endIn,
			p3: segment.end,
			t: clampedT,
		}),
	};
}

export function insertPointIntoFreeformSegment({
	points,
	segmentIndex,
	pointId,
	t,
	closed,
}: {
	points: FreeformPathPoint[];
	segmentIndex: number;
	pointId: string;
	t: number;
	closed: boolean;
}): FreeformPathPoint[] {
	const indices = getFreeformSegmentIndices({
		points,
		segmentIndex,
		closed,
	});
	if (!indices) {
		return points;
	}

	const startPoint = points[indices.startIndex];
	const endPoint = points[indices.endIndex];
	const clampedT = Math.min(0.999, Math.max(0.001, t));
	const p0 = { x: startPoint.x, y: startPoint.y };
	const p1 = {
		x: startPoint.x + startPoint.outX,
		y: startPoint.y + startPoint.outY,
	};
	const p2 = {
		x: endPoint.x + endPoint.inX,
		y: endPoint.y + endPoint.inY,
	};
	const p3 = { x: endPoint.x, y: endPoint.y };

	if (
		isZeroHandle({ x: startPoint.outX, y: startPoint.outY }) &&
		isZeroHandle({ x: endPoint.inX, y: endPoint.inY })
	) {
		const splitPoint = lerpPoint({ a: p0, b: p3, t: clampedT });
		const nextPoints = [...points];
		nextPoints.splice(indices.endIndex, 0, {
			id: pointId,
			x: splitPoint.x,
			y: splitPoint.y,
			inX: 0,
			inY: 0,
			outX: 0,
			outY: 0,
		});
		return nextPoints;
	}

	const p01 = lerpPoint({ a: p0, b: p1, t: clampedT });
	const p12 = lerpPoint({ a: p1, b: p2, t: clampedT });
	const p23 = lerpPoint({ a: p2, b: p3, t: clampedT });
	const p012 = lerpPoint({ a: p01, b: p12, t: clampedT });
	const p123 = lerpPoint({ a: p12, b: p23, t: clampedT });
	const splitPoint = lerpPoint({ a: p012, b: p123, t: clampedT });

	const nextPoints = [...points];
	nextPoints[indices.startIndex] = {
		...startPoint,
		outX: p01.x - startPoint.x,
		outY: p01.y - startPoint.y,
	};
	nextPoints[indices.endIndex] = {
		...endPoint,
		inX: p23.x - endPoint.x,
		inY: p23.y - endPoint.y,
	};
	nextPoints.splice(indices.endIndex, 0, {
		id: pointId,
		x: splitPoint.x,
		y: splitPoint.y,
		inX: p012.x - splitPoint.x,
		inY: p012.y - splitPoint.y,
		outX: p123.x - splitPoint.x,
		outY: p123.y - splitPoint.y,
	});
	return nextPoints;
}

export function insertPointOnFreeformSegment({
	params,
	segmentIndex,
	canvasPoint,
	bounds,
	pointId = generateUUID(),
}: {
	params: FreeformPathMaskParams;
	segmentIndex: number;
	canvasPoint: { x: number; y: number };
	bounds: ElementBounds;
	pointId?: string;
}): { params: FreeformPathMaskParams; pointId: string } | null {
	const points = params.path;
	if (getFreeformSegmentCount({ points, closed: params.closed }) === 0) {
		return null;
	}

	const closestPoint = findClosestPointOnFreeformSegment({
		points,
		segmentIndex,
		canvasPoint,
		centerX: params.centerX,
		centerY: params.centerY,
		rotation: params.rotation,
		scale: params.scale,
		bounds,
		closed: params.closed,
	});
	if (!closestPoint) {
		return null;
	}

	const nextPoints = insertPointIntoFreeformSegment({
		points,
		segmentIndex,
		pointId,
		t: closestPoint.t,
		closed: params.closed,
	});
	if (nextPoints.length === points.length) {
		return null;
	}

	const recentered = recenterFreeformPath({
		points: nextPoints,
		centerX: params.centerX,
		centerY: params.centerY,
		rotation: params.rotation,
		scale: params.scale,
		bounds,
	});

	return {
		pointId,
		params: {
			...params,
			centerX: recentered.centerX,
			centerY: recentered.centerY,
			path: recentered.points,
		},
	};
}
