import { describe, expect, test } from "bun:test";
import {
	CUT_SILENCE_ACTIONS,
	DEFAULT_CUT_SILENCE_MODE,
	executeCutSilenceAction,
} from "@/timeline/components/cut-silence-toolbar-options";

describe("cut silence toolbar options", () => {
	test("keeps the fast analysis as the one-click default", () => {
		expect(DEFAULT_CUT_SILENCE_MODE).toBe("fast");
		expect(CUT_SILENCE_ACTIONS[0]).toMatchObject({
			mode: "fast",
			label: "Fast cut (default)",
		});
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
		const calls: Array<{ mode: "fast" | "deep" }> = [];

		await executeCutSilenceAction({
			mode: "deep",
			removeAllSilence: async (options) => {
				calls.push(options);
			},
		});

		expect(calls).toEqual([{ mode: "deep" }]);
	});
});
