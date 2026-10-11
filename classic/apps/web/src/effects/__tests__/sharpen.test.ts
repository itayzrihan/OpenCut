import { describe, expect, test } from "bun:test";
import { sharpenEffectDefinition as definition } from "../definitions/sharpen";
describe("Sharpen", () => {
	test("defaults to fifteen percent and clamps the rendered amount", () => {
		expect(definition.params[0].default).toBe(15);
		const render = (intensity?: number) =>
			definition.renderer.passes[0].uniforms({
				effectParams: intensity === undefined ? {} : { intensity },
				width: 1920,
				height: 1080,
			});
		expect(render()).toEqual({ u_intensity: 0.15 });
		expect(render(0)).toEqual({ u_intensity: 0 });
		expect(render(100)).toEqual({ u_intensity: 1 });
		expect(render(200)).toEqual({ u_intensity: 1 });
		expect(render(NaN)).toEqual({ u_intensity: 0.15 });
	});
});
