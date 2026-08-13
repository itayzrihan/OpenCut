import { describe, expect, test } from "bun:test";
import {
	buildParallaxMotionLoopParams,
	calculateSafeViewportScale,
	resolveParallaxMotionLoopFrame,
} from "@/parallax-story-teller/motion-loop";
import { mediaTimeFromSeconds } from "@/wasm";

describe("Parallax Story motion loops", () => {
	test("keeps loops inside their selected time range", () => {
		const duration = mediaTimeFromSeconds({ seconds: 10 });
		const params = buildParallaxMotionLoopParams({
			params: {},
			patch: {
				presetId: "shake-subtle",
				startPercent: 20,
				endPercent: 70,
			},
		});

		expect(
			resolveParallaxMotionLoopFrame({
				params,
				localTime: mediaTimeFromSeconds({ seconds: 1.9 }),
				duration,
				width: 1080,
				height: 1920,
			}),
		).toBeNull();
		expect(
			resolveParallaxMotionLoopFrame({
				params,
				localTime: mediaTimeFromSeconds({ seconds: 4 }),
				duration,
				width: 1080,
				height: 1920,
			}),
		).not.toBeNull();
		expect(
			resolveParallaxMotionLoopFrame({
				params,
				localTime: mediaTimeFromSeconds({ seconds: 7.1 }),
				duration,
				width: 1080,
				height: 1920,
			}),
		).toBeNull();
	});

	test("adds enough zoom for translation and rotation to cover every corner", () => {
		const width = 1080;
		const height = 1920;
		const translateX = 20;
		const translateY = -12;
		const rotate = 4;
		const scale = calculateSafeViewportScale({
			width,
			height,
			translateX,
			translateY,
			rotate,
		});
		const radians = (-rotate * Math.PI) / 180;
		const cos = Math.cos(radians);
		const sin = Math.sin(radians);

		for (const x of [-width / 2, width / 2]) {
			for (const y of [-height / 2, height / 2]) {
				const translatedCornerX = x - translateX;
				const translatedCornerY = y - translateY;
				const sourceX =
					(translatedCornerX * cos - translatedCornerY * sin) / scale;
				const sourceY =
					(translatedCornerX * sin + translatedCornerY * cos) / scale;
				expect(Math.abs(sourceX)).toBeLessThanOrEqual(width / 2 + 0.000001);
				expect(Math.abs(sourceY)).toBeLessThanOrEqual(height / 2 + 0.000001);
			}
		}
	});

	test("compensates when a loop frame scales below the viewport", () => {
		const duration = mediaTimeFromSeconds({ seconds: 8.4 });
		const params = buildParallaxMotionLoopParams({
			params: {},
			patch: {
				presetId: "zoom-breathe",
				cycleSeconds: 4.2,
				startPercent: 0,
				endPercent: 100,
			},
		});
		const frame = resolveParallaxMotionLoopFrame({
			params,
			localTime: mediaTimeFromSeconds({ seconds: 4.2 }),
			duration,
			width: 1080,
			height: 1920,
		});

		expect(frame).not.toBeNull();
		expect((frame?.scale ?? 0) * (frame?.safeScale ?? 0)).toBeGreaterThanOrEqual(
			1,
		);
	});
});
