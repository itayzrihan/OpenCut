import type {
	TextCaptionRevealMode,
	TextWordDirection,
	TextWordTransitionIn,
} from "@/timeline";

export const REVEAL_MODES: Array<{
	value: TextCaptionRevealMode;
	label: string;
}> = [
	{ value: "determined-by-preset", label: "Determined by animation" },
	{ value: "row", label: "Whole row" },
	{ value: "spoken-word", label: "Spoken word only" },
	{ value: "spoken-word-keep", label: "Spoken word, keep previous" },
	{ value: "emphasize-spoken", label: "Emphasize spoken" },
	{ value: "emphasize-spoken-keep", label: "Keep emphasized" },
	{ value: "letter-by-letter", label: "Letter by letter typing" },
	{ value: "growing-row", label: "Growing row" },
];

export const TRANSITION_IN_OPTIONS: Array<{
	value: TextWordTransitionIn;
	label: string;
}> = [
	{ value: "none", label: "None" },
	{ value: "fade", label: "Fade" },
	{ value: "blur", label: "Blur build" },
	{ value: "zoom", label: "Zoom" },
	{ value: "blur-zoom", label: "Blur zoom" },
	{ value: "rise", label: "Rise" },
	{ value: "slide", label: "Slide" },
	{ value: "typewriter", label: "Type letter by letter" },
	{ value: "glow-dissolve", label: "Glow blur dissolve" },
];

export const WORD_DIRECTIONS: Array<{
	value: TextWordDirection;
	label: string;
}> = [
	{ value: "auto", label: "Auto" },
	{ value: "rtl", label: "Right to left" },
	{ value: "ltr", label: "Left to right" },
];

export function toWordDirection(value: string): TextWordDirection {
	return value === "rtl" || value === "ltr" ? value : "auto";
}

export function toRevealMode(value: string): TextCaptionRevealMode {
	return value === "determined-by-preset" ||
		value === "row" ||
		value === "spoken-word" ||
		value === "spoken-word-keep" ||
		value === "emphasize-spoken" ||
		value === "emphasize-spoken-keep" ||
		value === "letter-by-letter" ||
		value === "growing-row"
		? value
		: "determined-by-preset";
}

export function toTransitionIn(value: string): TextWordTransitionIn {
	return value === "none" ||
		value === "fade" ||
		value === "blur" ||
		value === "zoom" ||
		value === "blur-zoom" ||
		value === "rise" ||
		value === "slide" ||
		value === "typewriter" ||
		value === "glow-dissolve"
		? value
		: "none";
}

export function usesTransitionIn(revealMode: TextCaptionRevealMode): boolean {
	return (
		revealMode === "spoken-word" ||
		revealMode === "spoken-word-keep" ||
		revealMode === "letter-by-letter" ||
		revealMode === "growing-row"
	);
}
