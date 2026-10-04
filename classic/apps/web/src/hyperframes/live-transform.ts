import type { QuadTransformDescriptor } from "@/services/renderer/compositor/types";

/** Platform presentation of the same plane projected by compositor/layer.wgsl. */
export function hyperframesLiveTransform({
	quad,
	sourceWidth,
	sourceHeight,
}: {
	quad: QuadTransformDescriptor;
	sourceWidth: number;
	sourceHeight: number;
}): string {
	// The shader projects with d / (d + z). CSS uses d / (d - z), so both
	// tilt signs reverse. Apply Y then X, after sizing and before Z rotation.
	const perspective =
		quad.perspectiveXDegrees || quad.perspectiveYDegrees
			? ` perspective(${Math.max(1, Math.max(quad.width, quad.height) * 1.5)}px) rotateX(${-quad.perspectiveXDegrees}deg) rotateY(${-quad.perspectiveYDegrees}deg)`
			: "";
	return `translate(-50%, -50%) rotate(${quad.rotationDegrees}deg)${perspective} scale(${((quad.flipX ? -1 : 1) * quad.width) / sourceWidth}, ${((quad.flipY ? -1 : 1) * quad.height) / sourceHeight})`;
}
