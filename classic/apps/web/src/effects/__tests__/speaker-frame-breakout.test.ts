import { describe, expect, test } from "bun:test";
import { speakerFrameBreakoutEffectDefinition } from "@/effects/definitions/speaker-frame-breakout";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
} from "@/simple-advanced-layers/speaker-frame-breakout";

describe("Speaker Frame Breakout effect definition", () => {
	test("keeps every smart-layer default in the native definition", () => {
		const definitionDefaults = Object.fromEntries(
			speakerFrameBreakoutEffectDefinition.params.map((param) => [
				param.key,
				param.default,
			]),
		);

		expect(speakerFrameBreakoutEffectDefinition.type).toBe(
			SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		);
		expect(speakerFrameBreakoutEffectDefinition.renderer.passes).toEqual([]);
		expect(definitionDefaults).toEqual(SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS);
	});
});
