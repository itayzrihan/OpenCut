import { expect, mock, test } from "bun:test";
import { wasm } from "../../../../test-support/wasm";
mock.module("opencut-wasm", () => wasm);
const { mediaTime } = await import("@/wasm");
const { buildCanvasPanElement } = await import("@/parallax-story-teller/model");
const { ParallaxSceneNode } = await import("../nodes/parallax-scene-node");
const { ColorNode } = await import("../nodes/color-node");
const { resolveRenderTree } = await import("../resolve");
const { buildFrameDescriptor } = await import("../compositor/frame-descriptor");
const { directionalBlurEffectDefinition } =
	await import("@/effects/definitions/directional-blur");

test("nested opacity resolves on the parent clock and composites the whole group", async () => {
	const element = buildCanvasPanElement({
		sceneId: "nested",
		startTime: mediaTime({ ticks: 0 }),
		setup: {
			templateId: "blank",
			worldWidthFrames: 1,
			durationSeconds: 8,
			direction: "right",
		},
	});
	const node = new ParallaxSceneNode({
		timeOffset: 120000,
		duration: 960000,
		sourceDuration: 960000,
		effectParams: element.params,
		storyParams: { ...element.params, opacity: 1 },
		storyAnimations: {
			opacity: {
				keys: [
					{
						id: "a",
						time: mediaTime({ ticks: 0 }),
						value: 1,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "b",
						time: mediaTime({ ticks: 960000 }),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
		cameraDuration: 960000,
		cameraTimeOffset: 0,
		cameraUsesSourceTime: false,
		worldWidthFrames: 1,
		worldHeightFrames: 1,
	});
	node.add(new ColorNode({ color: "#ffffff" }));
	const renderer = { width: 1920, height: 1080 };
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 600000 }),
	});
	expect(node.resolved?.opacity).toBeCloseTo(0.5);
	const { frame } = await buildFrameDescriptor({ node, renderer });
	expect(frame.items[0]).toMatchObject({ type: "group", opacity: 0.5 });
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 120000 }),
	});
	expect(node.resolved?.opacity).toBe(1);
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 1080000 }),
	});
	expect(node.resolved).toBeNull();
});

test("directional blur remains resolution aware and does not add orthogonal softness", () => {
	const build = directionalBlurEffectDefinition.renderer.buildPasses!;
	expect(
		build({
			effectParams: { amount: 0, angle: 30 },
			width: 1920,
			height: 1080,
		}),
	).toEqual([]);
	const passes = build({
		effectParams: { amount: 13, angle: 90 },
		width: 3840,
		height: 2160,
	});
	expect(passes.length).toBe(1);
	expect(passes[0].uniforms.u_sigma).toBe(26);
	const direction = passes[0].uniforms.u_direction;
	if (!Array.isArray(direction)) throw new Error("Expected direction vector");
	expect(direction[0]).toBeCloseTo(0);
	expect(direction[1]).toBe(1);
});

test("effect layer blur keyframes resolve before building compositor passes", async () => {
	const { EffectLayerNode } = await import("../nodes/effect-layer-node");
	const { registerDefaultEffects } = await import("@/effects/definitions");
	registerDefaultEffects();
	const node = new EffectLayerNode({
		effectType: "blur",
		effectParams: { intensity: 0 },
		timeOffset: 120000,
		duration: 240000,
		effectAnimations: {
			"params.intensity": {
				keys: [
					{
						id: "a",
						time: mediaTime({ ticks: 0 }),
						value: 0,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
					{
						id: "b",
						time: mediaTime({ ticks: 240000 }),
						value: 100,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	});
	const renderer = { width: 1920, height: 1080 };
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 120000 }),
	});
	expect(node.resolved).toBeNull();
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 240000 }),
	});
	expect(node.resolved?.passes[0].uniforms.u_sigma).toBe(10);
	await resolveRenderTree({
		node,
		renderer,
		time: mediaTime({ ticks: 120000 }),
	});
	expect(node.resolved).toBeNull();
});
