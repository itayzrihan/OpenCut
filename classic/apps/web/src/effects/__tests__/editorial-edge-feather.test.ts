import { describe, expect, test } from "bun:test";
import {
	EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
	editorialEdgeFeatherEffectDefinition,
} from "@/effects/definitions/editorial-edge-feather";
import { OVERLAY_EFFECT_PRESETS } from "@/effects/overlay-presets";

describe("editorial edge feather", () => {
	test("builds an editable native top-and-bottom feather pass", () => {
		const effectParams = {
			intensity: 60,
			height: 30,
			softness: 80,
			color: "#000000",
		};
		const passes = editorialEdgeFeatherEffectDefinition.renderer.passes.map(
			(pass) => ({
				shader: pass.shader,
				uniforms: pass.uniforms({
					effectParams,
					width: 1080,
					height: 1920,
				}),
			}),
		);

		expect(
			Object.fromEntries(
				editorialEdgeFeatherEffectDefinition.params.map((param) => [
					param.key,
					param.default,
				]),
			),
		).toEqual(effectParams);
		expect(passes).toEqual([
			{
				shader: EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
				uniforms: {
					u_intensity: 0.6,
					u_height: 0.3,
					u_softness: 0.8,
					u_color: [0, 0, 0, 1],
				},
			},
		]);
	});

	test("publishes the native effect through the manual and AI overlay catalog", () => {
		const preset = OVERLAY_EFFECT_PRESETS.find(
			(item) => item.id === "editorial-edge-feather",
		);

		expect(preset?.effectType).toBe(EDITORIAL_EDGE_FEATHER_EFFECT_TYPE);
		expect(preset?.params.height).toBe(30);
	});
});
