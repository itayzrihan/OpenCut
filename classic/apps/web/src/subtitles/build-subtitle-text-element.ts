import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { setCanvasLetterSpacing } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import type { CreateTextElement } from "@/timeline";
import type { CaptionLayoutSettings } from "./caption-layout";
import type { SubtitleCue } from "./types";
import { buildCaptionText, type CaptionTextMeasureQuery } from "opencut-wasm";

export function buildSubtitleTextElement(input: {
	index: number;
	caption: SubtitleCue;
	canvasSize: { width: number; height: number };
	revealMode?: CreateTextElement["captionRevealMode"];
	transitionIn?: CreateTextElement["captionTransitionIn"];
	wordAnimationId?: string;
	accentColor?: string;
	wordDirection?: CreateTextElement["captionWordDirection"];
	layoutSettings?: CaptionLayoutSettings;
}): CreateTextElement {
	const canvas = document.createElement("canvas");
	canvas.width = 4096;
	canvas.height = 4096;
	const ctx = canvas.getContext("2d");
	const measure = ctx
		? ({ text, font, letterSpacing }: CaptionTextMeasureQuery) => {
				ctx.font = font;
				setCanvasLetterSpacing({ ctx, letterSpacingPx: letterSpacing });
				return ctx.measureText(text).width;
			}
		: undefined;
	const result = buildCaptionText({
		inputJson: JSON.stringify(
			{
				...input,
				defaults: DEFAULTS.text,
				fontSizeScaleReference: FONT_SIZE_SCALE_REFERENCE,
			},
			(_key, value) =>
				typeof value === "number" && !Number.isFinite(value)
					? { nonFinite: true }
					: value,
		),
		measure,
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The shared Rust builder returns the serialized caption clip; browser glyph measurement does not own editing policy.
	return JSON.parse(result) as CreateTextElement;
}
