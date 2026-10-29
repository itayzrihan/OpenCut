import { describe, expect, test } from "bun:test";
import {
	CUT_SILENCE_ACTIONS,
	DEFAULT_CUT_SILENCE_MODE,
	executeCutSilenceAction,
} from "@/timeline/components/cut-silence-toolbar-options";

describe("cut silence toolbar options", () => {
	test("uses Protect Speech as the one-click default", () => {
		expect(DEFAULT_CUT_SILENCE_MODE).toBe("smart");
		expect(CUT_SILENCE_ACTIONS[0]).toMatchObject({
			mode: "smart",
			label: "Smart audio cut · protect speech (default)",
		});
		expect(CUT_SILENCE_ACTIONS[0]?.description).toContain("speech margins");
		expect(CUT_SILENCE_ACTIONS[0]?.description).toContain("captioned words");
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
			mode: "audio" | "smart" | "fast" | "deep";
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

	test("default smart cut forwards its duration and cancellation", async () => {
		const controller = new AbortController();
		const calls: unknown[] = [];
		expect(DEFAULT_CUT_SILENCE_MODE).toBe("smart");
		expect(
			CUT_SILENCE_ACTIONS.find((action) => action.mode === "smart")
				?.description,
		).toContain("average");
		await executeCutSilenceAction({
			mode: DEFAULT_CUT_SILENCE_MODE,
			minSilenceSeconds: 0.8,
			signal: controller.signal,
			removeAllSilence: async (options) => {
				calls.push(options);
			},
		});
		expect(calls).toEqual([
			{ mode: "smart", minSilenceSeconds: 0.8, signal: controller.signal },
		]);
	});
});
