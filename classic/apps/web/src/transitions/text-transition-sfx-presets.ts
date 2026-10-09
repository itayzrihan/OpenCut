export interface TextTransitionSfxPreset {
	transitionId: string;
	side: "in" | "out";
	assetId: string;
	name: string;
	leadInSeconds: number;
	durationSeconds: number;
	sourceDurationSeconds: number;
	trimStartSeconds: number;
	trimEndSeconds: number;
	volume: number;
}

// Authored Galya/ROGA companion timings are shared with the canonical runtime.
import definitions from "../../../../rust/crates/timeline/data/text-transition-sfx-presets.json";

export function getTextTransitionSfxPreset({
    transitionId,
    side,
}: {
    transitionId: string;
    side?: "in" | "out";
}): TextTransitionSfxPreset | null {
    const preset = definitions.find((entry) => entry.transitionId === transitionId);
    if (!preset || (side && preset.side !== side)) return null;
    if (preset.side !== "in" && preset.side !== "out") return null;
    return { ...preset, side: preset.side };
}

export function hasTextTransitionSfx({
	transitionId,
	side,
}: {
	transitionId: string;
	side?: "in" | "out";
}): boolean {
	return getTextTransitionSfxPreset({ transitionId, side }) !== null;
}
