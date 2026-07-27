import { describe, expect, test } from "bun:test";
import {
	buildDefaultEffectInstance,
	CUSTOM_AI_EFFECT_TYPE,
	getEffectDefinition,
	normalizeEffectType,
} from "@/effects";
import {
	buildCustomAiEffectParams,
	stringifyCustomAiEffectSpec,
} from "@/effects/custom-ai-effect";

describe("custom AI effect fallback", () => {
	test("normalizes descriptive blur requests to the built-in blur effect", () => {
		expect(normalizeEffectType("blur zoom")).toBe("blur");
		expect(normalizeEffectType("Zoom Blur")).toBe("blur");

		const effect = buildDefaultEffectInstance({ effectType: "blur zoom" });

		expect(effect.type).toBe("blur");
		expect(effect.params.intensity).toBe(15);
	});

	test("stores unknown descriptive effects as editable custom AI effects", () => {
		const effect = buildDefaultEffectInstance({
			effectType: "liquid neon chromatic burst",
		});
		const definition = getEffectDefinition(effect.type);

		expect(effect.type).toBe(CUSTOM_AI_EFFECT_TYPE);
		expect(effect.params.requestedType).toBe("liquid neon chromatic burst");
		expect(definition.name).toBe("Custom AI Edit");
		expect(
			definition.renderer.buildPasses?.({
				effectParams: effect.params,
				width: 1920,
				height: 1080,
			}),
		).toEqual([]);
	});

	test("stores structured custom edit specs as stable editable JSON", () => {
		const params = buildCustomAiEffectParams({
			requestedType: "kinetic caption entrance",
			label: "Kinetic caption entrance",
			kind: "animation",
			intent: "Make the caption pop in with staggered letters.",
			spec: {
				to: { opacity: 1, y: 0 },
				from: { y: 30, opacity: 0 },
				ease: "back.out",
			},
		});

		expect(params.label).toBe("Kinetic caption entrance");
		expect(params.kind).toBe("animation");
		expect(params.specJson).toBe(
			[
				"{",
				'  "ease": "back.out",',
				'  "from": {',
				'    "opacity": 0,',
				'    "y": 30',
				"  },",
				'  "to": {',
				'    "opacity": 1,',
				'    "y": 0',
				"  }",
				"}",
			].join("\n"),
		);
	});

	test("normalizes JSON strings when storing custom specs", () => {
		expect(
			stringifyCustomAiEffectSpec({
				spec: '{"z":2,"a":{"b":1}}',
			}),
		).toBe(['{', '  "a": {', '    "b": 1', "  },", '  "z": 2', "}"].join("\n"));
	});

	test("renders blur-like custom edit specs with Gaussian blur passes", () => {
		const definition = getEffectDefinition(CUSTOM_AI_EFFECT_TYPE);
		const params = buildCustomAiEffectParams({
			requestedType: "blur zoom",
			label: "Blur zoom",
			kind: "animation",
			spec: {
				from: { filter: "blur(18px)", scale: 1.25 },
				to: { filter: "blur(0px)", scale: 1 },
			},
		});

		const passes =
			definition.renderer.buildPasses?.({
				effectParams: params,
				width: 1920,
				height: 1080,
			}) ?? [];

		expect(passes.length).toBeGreaterThan(0);
		expect(passes[0]?.shader).toBe("gaussian-blur");
	});

	test("renders fixed AI effect templates as shader passes", () => {
		const definition = getEffectDefinition(CUSTOM_AI_EFFECT_TYPE);
		const params = buildCustomAiEffectParams({
			requestedType: "rgb split",
			label: "RGB Split",
			spec: {
				template: "rgb-split",
				intensity: 70,
				color: "#33ccff",
			},
		});

		const passes =
			definition.renderer.buildPasses?.({
				effectParams: params,
				width: 1920,
				height: 1080,
				localTime: 60_000,
			}) ?? [];

		expect(passes).toEqual([
			{
				shader: "rgb-split",
				uniforms: {
					u_intensity: 0.7,
					u_amount: 20.599999999999998,
				},
			},
		]);
	});

	test("passes local time into animated AI effect templates", () => {
		const definition = getEffectDefinition(CUSTOM_AI_EFFECT_TYPE);
		const params = buildCustomAiEffectParams({
			requestedType: "noise",
			label: "Analog Noise",
			spec: {
				template: "noise",
				intensity: 50,
				seed: 12,
			},
		});

		const passes =
			definition.renderer.buildPasses?.({
				effectParams: params,
				width: 1920,
				height: 1080,
				localTime: 240_000,
			}) ?? [];

		expect(passes[0]).toMatchObject({
			shader: "noise",
			uniforms: {
				u_intensity: 0.5,
				u_amount: 2,
				u_time: 2,
				u_seed: 12,
			},
		});
	});
});
