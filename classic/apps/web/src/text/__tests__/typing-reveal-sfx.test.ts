import { describe, expect, test } from "bun:test";
import {
	planTypingRevealSfxSegments,
	TYPING_REVEAL_SFX_ASSET_ID,
	TYPING_REVEAL_SFX_SOURCE_TICKS,
	TYPING_REVEAL_SFX_VOLUME_DB,
} from "@/text/typing-reveal-sfx-preset";

describe("letter-by-letter typing SFX", () => {
	test("uses the stable asset observed through MCP", () => {
		expect(TYPING_REVEAL_SFX_ASSET_ID).toBe(
			"da73d7d4-9b71-4a24-84ad-f6c51034354c",
		);
		expect(TYPING_REVEAL_SFX_SOURCE_TICKS).toBe(1_872_000);
		expect(TYPING_REVEAL_SFX_VOLUME_DB).toBe(-5);
	});

	test("trims one source clip to the full text-layer duration", () => {
		expect(planTypingRevealSfxSegments({ durationTicks: 189_600 })).toEqual([
			{ offsetTicks: 0, durationTicks: 189_600 },
		]);
	});

	test("tiles contiguous clips when a layer exceeds the source", () => {
		expect(
			planTypingRevealSfxSegments({
				durationTicks: TYPING_REVEAL_SFX_SOURCE_TICKS + 120_000,
			}),
		).toEqual([
			{ offsetTicks: 0, durationTicks: 1_872_000 },
			{ offsetTicks: 1_872_000, durationTicks: 120_000 },
		]);
	});
});
