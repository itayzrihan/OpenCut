import { describe, expect, test } from "bun:test";
import type { ImageNodeParams } from "@/services/renderer/nodes/image-node";
import { ImageNode } from "@/services/renderer/nodes/image-node";
import type { VideoNodeParams } from "@/services/renderer/nodes/video-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import {
	isStaticRenderNode,
	isStaticRenderNodeActiveAtTime,
} from "@/services/renderer/static-node-cache";

const transform = {
	position: { x: 0, y: 0 },
	scaleX: 1,
	scaleY: 1,
	rotate: 0,
	perspectiveX: 0,
	perspectiveY: 0,
};

function createImageParams(
	overrides: Partial<ImageNodeParams> = {},
): ImageNodeParams {
	return {
		url: "https://example.com/image.png",
		duration: 10,
		timeOffset: 2,
		trimStart: 0,
		trimEnd: 10,
		transform,
		opacity: 1,
		...overrides,
	};
}

function createImageNode(
	overrides: Partial<ImageNodeParams> = {},
): ImageNode {
	return new ImageNode(createImageParams(overrides));
}

describe("static renderer node classification", () => {
	test("treats plain image layers as static while active", () => {
		const node = createImageNode();

		expect(isStaticRenderNode(node)).toBe(true);
		expect(
			isStaticRenderNodeActiveAtTime({ node, time: 2 }),
		).toBe(true);
		expect(
			isStaticRenderNodeActiveAtTime({ node, time: 12 }),
		).toBe(false);
	});

	test("keeps animated image layers on the per-frame path", () => {
		const node = createImageNode({ animations: { opacity: {} } });

		expect(isStaticRenderNode(node)).toBe(false);
	});

	test("never classifies video layers as static", () => {
		const node = new VideoNode({
			mediaId: "video-1",
			isPreview: true,
			...createImageParams(),
		} satisfies VideoNodeParams);

		expect(isStaticRenderNode(node)).toBe(false);
	});
});
