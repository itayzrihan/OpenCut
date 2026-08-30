import { describe, expect, test } from "bun:test";
import { resolveVisualFitScale } from "@/rendering/fit-mode";

describe("visual fit mode", () => {
	test("covers a portrait frame with landscape video by cropping its sides", () => {
		const scale = resolveVisualFitScale({
			containerWidth: 1080,
			containerHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			fitMode: "cover",
		});

		expect(scale).toBeCloseTo(1920 / 1080);
		expect(1920 * scale).toBeGreaterThan(1080);
		expect(1080 * scale).toBe(1920);
	});

	test("contains the same video when the complete image must remain visible", () => {
		const scale = resolveVisualFitScale({
			containerWidth: 1080,
			containerHeight: 1920,
			sourceWidth: 1920,
			sourceHeight: 1080,
			fitMode: "contain",
		});

		expect(scale).toBeCloseTo(1080 / 1920);
		expect(1920 * scale).toBe(1080);
		expect(1080 * scale).toBeLessThan(1920);
	});
});
