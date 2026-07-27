export type CutSilenceMode = "fast" | "deep";

export const DEFAULT_CUT_SILENCE_MODE: CutSilenceMode = "fast";

export const CUT_SILENCE_ACTIONS = [
	{
		mode: "fast",
		label: "Fast cut (default)",
		description: "Quickly removes clear, sustained silence.",
	},
	{
		mode: "deep",
		label: "Deep audio analysis",
		description:
			"Takes longer. Adapts to background noise, finds speech pauses, and refines caption timing.",
	},
] as const satisfies ReadonlyArray<{
	mode: CutSilenceMode;
	label: string;
	description: string;
}>;

export async function executeCutSilenceAction({
	mode,
	removeAllSilence,
}: {
	mode: CutSilenceMode;
	removeAllSilence: (options: { mode: CutSilenceMode }) => Promise<unknown>;
}): Promise<void> {
	await removeAllSilence({ mode });
}
