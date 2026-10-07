export type CutSilenceMode = "audio" | "smart" | "fast" | "deep";
export type CutSilenceOptions = {
	mode: CutSilenceMode;
	minSilenceSeconds?: number;
	signal?: AbortSignal;
};

export const DEFAULT_CUT_SILENCE_MODE: CutSilenceMode = "audio";

export const CUT_SILENCE_ACTIONS = [
	{
		mode: "audio",
		label: "Audio-based tight cut (default)",
		description:
			"Removes audio pauses from 0.3 seconds and keeps existing captions synchronized.",
	},
	{
		mode: "smart",
		label: "Smart audio cut · protect speech",
		description:
			"Uses the whole clip’s average sound level, keeps speech margins and protects captioned words. Leaves uncertain pauses intact.",
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
	signal,
	removeAllSilence,
}: {
	mode: CutSilenceMode;
	minSilenceSeconds?: number;
	signal?: AbortSignal;
	removeAllSilence: (options: CutSilenceOptions) => Promise<unknown>;
}): Promise<void> {
	await removeAllSilence({
		mode,
		...(minSilenceSeconds === undefined ? {} : { minSilenceSeconds }),
		...(signal === undefined ? {} : { signal }),
	});
}
