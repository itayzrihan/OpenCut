import type {
	MaskDefinition,
	MaskInteractionDefinition,
	RoundedRectangleMaskParams,
} from "@/masks/types";
import type { ParamDefinition } from "@/params";
import {
	BOX_LIKE_MASK_PARAMS,
	buildBoxMaskInteraction,
	computeBoxMaskParamUpdate,
	getBoxLikeGeometry,
	getDefaultSquareMaskParams,
	getStrokeOffset,
	rotatePoint,
} from "../box-like";

const ROUNDED_RECTANGLE_PARAMS: ParamDefinition<
	keyof RoundedRectangleMaskParams & string
>[] = [
	...BOX_LIKE_MASK_PARAMS,
	{
		key: "cornerRadius",
		label: "Corner Radius",
		type: "number",
		default: 0.12,
		min: 0,
		max: 0.5,
		displayMultiplier: 100,
		step: 1,
	},
];

function buildRoundedRectanglePath({
	centerX,
	centerY,
	width,
	height,
	rotationRad,
	cornerRadius,
}: {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationRad: number;
	cornerRadius: number;
}): Path2D {
	const halfWidth = Math.max(1, width / 2);
	const halfHeight = Math.max(1, height / 2);
	const radius = Math.min(
		halfWidth,
		halfHeight,
		Math.max(0, cornerRadius) * Math.min(width, height),
	);
	const point = (x: number, y: number) =>
		rotatePoint({
			x: centerX + x,
			y: centerY + y,
			centerX,
			centerY,
			rotationRad,
		});
	const path = new Path2D();
	const move = point(-halfWidth + radius, -halfHeight);
	path.moveTo(move.x, move.y);

	const topEnd = point(halfWidth - radius, -halfHeight);
	const topRight = point(halfWidth, -halfHeight);
	const rightStart = point(halfWidth, -halfHeight + radius);
	path.lineTo(topEnd.x, topEnd.y);
	path.quadraticCurveTo(topRight.x, topRight.y, rightStart.x, rightStart.y);

	const rightEnd = point(halfWidth, halfHeight - radius);
	const bottomRight = point(halfWidth, halfHeight);
	const bottomStart = point(halfWidth - radius, halfHeight);
	path.lineTo(rightEnd.x, rightEnd.y);
	path.quadraticCurveTo(
		bottomRight.x,
		bottomRight.y,
		bottomStart.x,
		bottomStart.y,
	);

	const bottomEnd = point(-halfWidth + radius, halfHeight);
	const bottomLeft = point(-halfWidth, halfHeight);
	const leftStart = point(-halfWidth, halfHeight - radius);
	path.lineTo(bottomEnd.x, bottomEnd.y);
	path.quadraticCurveTo(bottomLeft.x, bottomLeft.y, leftStart.x, leftStart.y);

	const leftEnd = point(-halfWidth, -halfHeight + radius);
	const topLeft = point(-halfWidth, -halfHeight);
	const closeStart = point(-halfWidth + radius, -halfHeight);
	path.lineTo(leftEnd.x, leftEnd.y);
	path.quadraticCurveTo(topLeft.x, topLeft.y, closeStart.x, closeStart.y);
	path.closePath();
	return path;
}

export const roundedRectangleMaskDefinition: MaskDefinition<"rounded-rectangle"> =
	{
		type: "rounded-rectangle",
		name: "Rounded Rectangle",
		features: {
			hasPosition: true,
			hasRotation: true,
			sizeMode: "width-height",
		},
		params: ROUNDED_RECTANGLE_PARAMS,
		interaction: buildBoxMaskInteraction({
			sizeMode: "width-height",
		}) as unknown as MaskInteractionDefinition<RoundedRectangleMaskParams>,
		buildDefault(context) {
			return {
				type: "rounded-rectangle",
				params: {
					...getDefaultSquareMaskParams(context),
					cornerRadius: 0.12,
				},
			};
		},
		computeParamUpdate(args) {
			return computeBoxMaskParamUpdate(args);
		},
		renderer: {
			body: {
				kind: "fillPath",
				buildPath({ resolvedParams, width, height }) {
					const geometry = getBoxLikeGeometry({
						params: resolvedParams,
						width,
						height,
					});
					return buildRoundedRectanglePath({
						centerX: geometry.centerX,
						centerY: geometry.centerY,
						width: geometry.maskWidth,
						height: geometry.maskHeight,
						rotationRad: geometry.rotationRad,
						cornerRadius: resolvedParams.cornerRadius,
					});
				},
			},
			stroke: {
				kind: "strokeFromPath",
				buildStrokePath({ resolvedParams, width, height }) {
					const geometry = getBoxLikeGeometry({
						params: resolvedParams,
						width,
						height,
					});
					const offset = getStrokeOffset({
						strokeAlign: resolvedParams.strokeAlign,
						strokeWidth: resolvedParams.strokeWidth,
					});
					return buildRoundedRectanglePath({
						centerX: geometry.centerX,
						centerY: geometry.centerY,
						width: Math.max(1, geometry.maskWidth + offset * 2),
						height: Math.max(1, geometry.maskHeight + offset * 2),
						rotationRad: geometry.rotationRad,
						cornerRadius: resolvedParams.cornerRadius,
					});
				},
			},
		},
	};
