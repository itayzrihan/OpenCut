import { expect, test } from "bun:test";
import { createRetimeMapping } from "@/retime/resolve";
import type { RetimeConfig, SpeedInterpolation } from "@/timeline";
import { mediaTime } from "@/wasm/media-time";

test("source-anchored easing preserves the mapping across a trim or split", () => {
	const durations = {
		hold: 1500000,
		linear: 1000000,
		easeIn: 1125000,
		easeOut: 900000,
		easeInOut: 1000000,
	} satisfies Record<SpeedInterpolation, number>;
	for (const [interpolation, duration] of Object.entries(durations)) {
		const trimStart = 480000;
		const retime: RetimeConfig = {
			rate: 1.25,
			speedKeyframes: [
				{
					time: mediaTime({ ticks: trimStart }),
					rate: 1,
					interpolation: interpolation as SpeedInterpolation,
				},
				{
					time: mediaTime({ ticks: trimStart + 1500000 }),
					rate: 2,
					interpolation: "hold",
				},
			],
		};
		const full = createRetimeMapping({ retime, trimStart, ticks: true });
		expect(full.clipAt(1500000)).toBeCloseTo(duration, 6);
		if (interpolation === "linear")
			expect(full.rateAt(duration / 2)).toBeCloseTo(1.5, 6);
		const sourceSplit = 600000;
		const split = full.clipAt(sourceSplit);
		const right = createRetimeMapping({
			retime,
			trimStart: trimStart + sourceSplit,
			ticks: true,
		});
		expect(full.sourceAt(split)).toBeCloseTo(sourceSplit, 6);
		expect(right.sourceAt(400000)).toBeCloseTo(
			full.sourceAt(split + 400000) - sourceSplit,
			6,
		);
		expect(right.clipAt(-sourceSplit)).toBeCloseTo(-split, 6);
		const seconds = createRetimeMapping({
			retime,
			trimStart: trimStart / 120000,
		});
		expect(seconds.sourceAt(split / 120000)).toBeCloseTo(
			sourceSplit / 120000,
			8,
		);
	}
});
