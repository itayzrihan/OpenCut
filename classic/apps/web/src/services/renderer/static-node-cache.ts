import type { AnyBaseNode } from "./nodes/base-node";
import { ColorNode } from "./nodes/color-node";
import { ImageNode } from "./nodes/image-node";
import { RootNode } from "./nodes/root-node";
import { StickerNode } from "./nodes/sticker-node";
import { TextNode } from "./nodes/text-node";

const staticTreeCache = new WeakMap<AnyBaseNode, boolean>();

/**
 * Returns true only for nodes whose visual output is independent of the
 * current timeline time while they are active. Video, graphics, effects and
 * nodes with animation channels deliberately stay on the per-frame path.
 *
 * Scene building creates fresh node instances when document state changes, so
 * node identity is also the invalidation boundary for the caches using this
 * predicate.
 */
export function isStaticRenderNode(node: AnyBaseNode): boolean {
	if (node instanceof ColorNode) {
		return true;
	}

	if (node instanceof ImageNode || node instanceof StickerNode) {
		return hasNoTimeVaryingVisualState(node.params);
	}

	if (node instanceof TextNode) {
		return (
			hasNoAnimationChannels(node.params.animations) &&
			(node.params.effects?.length ?? 0) === 0 &&
			!node.params.clipMediaAsset
		);
	}

	return false;
}

export function isStaticRenderNodeActiveAtTime({
	node,
	time,
}: {
	node: AnyBaseNode;
	time: number;
}): boolean {
	if (node instanceof ColorNode) {
		return true;
	}

	if (node instanceof TextNode) {
		return isTimeRangeActive({
			time,
			startTime: node.params.startTime,
			duration: node.params.duration,
		});
	}

	if (node instanceof ImageNode || node instanceof StickerNode) {
		return isTimeRangeActive({
			time,
			startTime: node.params.timeOffset,
			duration: node.params.duration,
		});
	}

	return false;
}

/**
 * A whole-tree fast path is safe only when every static visual layer remains
 * active for the complete project duration. A timeline made of static clips
 * that appear and disappear is still time-dependent and must render normally.
 */
export function isStaticRenderTree(node: AnyBaseNode): boolean {
	const cached = staticTreeCache.get(node);
	if (cached !== undefined) {
		return cached;
	}

	let result = false;
	if (node instanceof RootNode) {
		const endTime = Math.max(0, node.duration - Number.EPSILON);
		result = node.children.every((child) =>
			isStaticRenderTreeForDuration({ node: child, endTime }),
		);
	}

	staticTreeCache.set(node, result);
	return result;
}

function isStaticRenderTreeForDuration({
	node,
	endTime,
}: {
	node: AnyBaseNode;
	endTime: number;
}): boolean {
	if (node instanceof RootNode) {
		return node.children.every((child) =>
			isStaticRenderTreeForDuration({ node: child, endTime }),
		);
	}

	if (!isStaticRenderNode(node)) {
		return false;
	}

	return (
		isStaticRenderNodeActiveAtTime({ node, time: 0 }) &&
		isStaticRenderNodeActiveAtTime({ node, time: endTime })
	);
}

function hasNoTimeVaryingVisualState(params: {
	animations?: object;
	effects?: readonly unknown[];
	masks?: readonly unknown[];
}): boolean {
	return (
		hasNoAnimationChannels(params.animations) &&
		(params.effects?.length ?? 0) === 0 &&
		(params.masks?.length ?? 0) === 0
	);
}

function hasNoAnimationChannels(animations: object | undefined): boolean {
	return !animations || Object.keys(animations).length === 0;
}

function isTimeRangeActive({
	time,
	startTime,
	duration,
}: {
	time: number;
	startTime: number;
	duration: number;
}): boolean {
	return time >= startTime && time < startTime + duration;
}
