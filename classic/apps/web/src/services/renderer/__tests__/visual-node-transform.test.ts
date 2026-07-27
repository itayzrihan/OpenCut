import { describe, expect, test } from "bun:test";
import type { ScalarAnimationChannel } from "@/animation/types";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

const renderer = {
	width: 1920,
	height: 1080,
};

function scalarChannel({
	from,
	to,
	durationSeconds,
}: {
	from: number;
	to: number;
	durationSeconds: number;
}): ScalarAnimationChannel {
	return {
		keys: [
			{
				id: "start",
				time: ZERO_MEDIA_TIME,
				value: from,
				segmentToNext: "linear",
				tangentMode: "flat",
			},
			{
				id: "end",
				time: mediaTimeFromSeconds({ seconds: durationSeconds }),
				value: to,
				segmentToNext: "linear",
				tangentMode: "flat",
			},
		],
	};
}

describe("visual node transform animation", () => {
	test("resolves preset background scale keyframes", async () => {
		const duration = mediaTimeFromSeconds({ seconds: 4 });
		const node = new GraphicNode({
			definitionId: "preset-background",
			params: {
				preset: "clean",
				presetId: "clean",
				colorA: "#10131f",
				colorB: "#f4f1e8",
				colorC: "#ffffff",
				density: 48,
				intensity: 55,
				scale: 52,
				seed: 3,
			},
			duration,
			timeOffset: ZERO_MEDIA_TIME,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			transform: {
				scaleX: 1,
				scaleY: 1,
				position: { x: 0, y: 0 },
				rotate: 0,
				perspectiveX: 0,
				perspectiveY: 0,
			},
			animations: {
				"transform.scaleX": scalarChannel({
					from: 1,
					to: 2,
					durationSeconds: 4,
				}),
				"transform.scaleY": scalarChannel({
					from: 1,
					to: 3,
					durationSeconds: 4,
				}),
				"transform.perspectiveX": scalarChannel({
					from: 0,
					to: 40,
					durationSeconds: 4,
				}),
				"transform.perspectiveY": scalarChannel({
					from: 0,
					to: -20,
					durationSeconds: 4,
				}),
				"transition.shatter": scalarChannel({
					from: 0,
					to: 1,
					durationSeconds: 4,
				}),
			},
			opacity: 1,
			blendMode: "normal",
			effects: [],
			masks: [],
		});

		await resolveRenderTree({
			node,
			renderer,
			time: mediaTimeFromSeconds({ seconds: 2 }),
		});

		expect(node.resolved?.transform.scaleX).toBe(1.5);
		expect(node.resolved?.transform.scaleY).toBe(2);
		expect(node.resolved?.transform.perspectiveX).toBe(20);
		expect(node.resolved?.transform.perspectiveY).toBe(-10);
		expect(node.resolved?.effectPasses.at(-1)?.[0]).toEqual({
			shader: "shatter",
			uniforms: { u_progress: 0.5, u_seed: 17 },
		});
	});
});
