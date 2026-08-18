export interface TextTransitionSfxPreset {
	transitionId: "push-right" | "slide-up" | "pop" | "grow";
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

const WHOOSH_ASSET_ID = "19f29ed9-a604-4933-ae8c-e494b6cee47f";
const METAL_SLICE_ASSET_ID = "49fd6fc0-53c5-4536-8370-ba27bb19ffcf";

/**
 * These values are copied from the repeated, user-authored examples in Galya2.
 * Asset IDs are deliberately stable even when the shared-library names change.
 */
const TEXT_TRANSITION_SFX_PRESETS: Record<
	TextTransitionSfxPreset["transitionId"],
	TextTransitionSfxPreset
> = {
	"push-right": {
		transitionId: "push-right",
		side: "in",
		assetId: WHOOSH_ASSET_ID,
		name: "Push Right SFX",
		leadInSeconds: 0.35,
		durationSeconds: 1.38,
		sourceDurationSeconds: 8.04,
		trimStartSeconds: 0,
		trimEndSeconds: 6.66,
		volume: -12.3,
	},
	"slide-up": {
		transitionId: "slide-up",
		side: "in",
		assetId: WHOOSH_ASSET_ID,
		name: "Slide Up SFX",
		leadInSeconds: 0.35,
		durationSeconds: 1.38,
		sourceDurationSeconds: 8.04,
		trimStartSeconds: 0,
		trimEndSeconds: 6.66,
		volume: -12.3,
	},
	pop: {
		transitionId: "pop",
		side: "in",
		assetId: METAL_SLICE_ASSET_ID,
		name: "Pop SFX",
		// Median of the three authored lead-ins: 0.386, 0.554, 0.537 s.
		leadInSeconds: 0.53655,
		durationSeconds: 1.729375,
		sourceDurationSeconds: 1.729375,
		trimStartSeconds: 0,
		trimEndSeconds: 0,
		volume: -21.9,
	},
	grow: {
		transitionId: "grow",
		side: "out",
		// Copied exactly from the user-authored Grow Out + swoosh pairing in ROGA2.
		assetId: "748324d3-6e31-4bff-92a2-843ea2e20127",
		name: "Grow Out SFX",
		leadInSeconds: 0.186225,
		durationSeconds: 1,
		sourceDurationSeconds: 5.88,
		trimStartSeconds: 0.36,
		trimEndSeconds: 4.52,
		volume: 0,
	},
};

export function getTextTransitionSfxPreset({
	transitionId,
	side,
}: {
	transitionId: string;
	side?: "in" | "out";
}): TextTransitionSfxPreset | null {
	let preset: TextTransitionSfxPreset | null;
	switch (transitionId) {
		case "push-right":
		case "slide-up":
		case "pop":
		case "grow":
			preset = TEXT_TRANSITION_SFX_PRESETS[transitionId];
			break;
		default:
			return null;
	}
	return side && preset.side !== side ? null : preset;
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
