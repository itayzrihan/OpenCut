import { describe, expect, test } from "bun:test";
import {
	CUT_SILENCE_ACTIONS,
	DEFAULT_CUT_SILENCE_MODE,
	executeCutSilenceAction,
} from "@/timeline/components/cut-silence-toolbar-options";

describe("cut silence toolbar options", () => {
	test("uses synchronized 0.1-second audio cutting as the one-click default", () => {
		expect(DEFAULT_CUT_SILENCE_MODE).toBe("audio");
		expect(CUT_SILENCE_ACTIONS[0]).toMatchObject({
			mode: "audio",
			label: "Audio-based tight cut (default)",
		});
		expect(CUT_SILENCE_ACTIONS[0]?.description).toContain("0.1 seconds");
		expect(CUT_SILENCE_ACTIONS[0]?.description).toContain("captions");
	});

	test("exposes a speech-aware deep analysis option", () => {
		const deepAction = CUT_SILENCE_ACTIONS.find(
			(action) => action.mode === "deep",
		);

		expect(deepAction?.label).toBe("Deep audio analysis");
		expect(deepAction?.description).toContain("background noise");
		expect(deepAction?.description).toContain("caption timing");
	});

	test("wires the selected mode into the manager action", async () => {
		const calls: Array<{
			mode: "audio" | "fast" | "deep";
			minSilenceSeconds?: number;
		}> = [];

		await executeCutSilenceAction({
			mode: "audio",
			minSilenceSeconds: 0.25,
			removeAllSilence: async (options) => {
				calls.push(options);
			},
		});

		expect(calls).toEqual([{ mode: "audio", minSilenceSeconds: 0.25 }]);
	});
});
