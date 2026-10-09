import catalog from "../../../../rust/crates/timeline/data/transition-presets.json";
import type { TransitionPreset, TransitionProperty } from "./types";

// Immutable feature definitions shared with the canonical Rust registry.
// Add a preset once in transition-presets.json; UI, agent and MCP discover it.
export const TRANSITION_PRESETS: TransitionPreset[] = catalog;
export const CONTROLLED_TRANSITION_PROPERTIES: TransitionProperty[] = [
	"opacity",
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"transition.shatter",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	"background.cornerRadius",
];
export function getTransitionPreset({ id }: { id: string }): TransitionPreset {
	return (
		TRANSITION_PRESETS.find((preset) => preset.id === id) ??
		TRANSITION_PRESETS[0]
	);
}
