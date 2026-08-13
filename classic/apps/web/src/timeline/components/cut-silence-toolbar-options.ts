export type CutSilenceMode = "audio" | "fast" | "deep";
export type CutSilenceOptions = {
	mode: CutSilenceMode;
	minSilenceSeconds?: number;
};

export const DEFAULT_CUT_SILENCE_MODE: CutSilenceMode = "audio";

export const CUT_SILENCE_ACTIONS = [
	{
		mode: "audio",
		label: "Audio-based tight cut (default)",
		description:
			"Removes audio pauses from 0.1 seconds and keeps existing captions synchronized.",
	},
	{
		mode: "fast",
		label: "Fast cut",
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
	minSilenceSeconds,
	removeAllSilence,
}: {
	mode: CutSilenceMode;
	minSilenceSeconds?: number;
	removeAllSilence: (options: CutSilenceOptions) => Promise<unknown>;
}): Promise<void> {
	await removeAllSilence({
		mode,
		...(minSilenceSeconds === undefined ? {} : { minSilenceSeconds }),
	});
}
