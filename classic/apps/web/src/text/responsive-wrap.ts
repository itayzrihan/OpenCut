import {
	setCanvasLetterSpacing,
	type TextLayoutMeasurementContext,
} from "./layout";
import {
	buildTextFontString,
	normalizeTextFontWeight,
	type TextLayoutParams,
} from "./primitives";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";
import type { TextElement, TextWordRun } from "@/timeline";

export function wrapTextToWidth({
	ctx,
	text,
	maxWidth,
}: {
	ctx: TextLayoutMeasurementContext;
	text: string;
	maxWidth: number;
}): string {
	const normalized = text.trim().replace(/\r\n/g, "\n");
	return normalized
		.split("\n")
		.map((paragraph) => {
			const words = paragraph.trim().split(/\s+/).filter(Boolean);
			if (words.length === 0) return "";

			const lines: string[] = [];
			let currentLine = words[0];
			for (let index = 1; index < words.length; index++) {
				const candidate = `${currentLine} ${words[index]}`;
				if (ctx.measureText(candidate).width <= maxWidth) {
					currentLine = candidate;
				} else {
					lines.push(currentLine);
					currentLine = words[index];
				}
			}
			lines.push(currentLine);
			return lines.join("\n");
		})
		.join("\n");
}

export function reflowResponsiveTextElement({
	element,
	text,
	canvasHeight,
	ctx,
}: {
	element: TextElement;
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextLayoutMeasurementContext;
}): { element: TextElement; text: TextLayoutParams } | null {
	const responsive = element.responsiveText;
	if (
		!responsive ||
		text.content !== responsive.generatedContent ||
		text.fontSize === responsive.fontSize
	) {
		return null;
	}

	const scaledFontSize =
		text.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	ctx.save();
	ctx.font = buildTextFontString({
		fontFamily: text.fontFamily,
		fontWeight: normalizeTextFontWeight({
			value: text.fontWeight,
			fallback: "normal",
		}),
		fontStyle: text.fontStyle,
		scaledFontSize,
	});
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: text.letterSpacing ?? 0,
	});
	const content = wrapTextToWidth({
		ctx,
		text: responsive.sourceContent,
		maxWidth: responsive.maxWidth * (canvasHeight / responsive.canvasHeight),
	});
	ctx.restore();

	return {
		text: { ...text, content },
		element: {
			...element,
			params: { ...element.params, content },
			wordRuns: reassignWordRunLines({
				wordRuns: element.wordRuns,
				content,
			}),
		},
	};
}

function reassignWordRunLines({
	wordRuns,
	content,
}: {
	wordRuns: TextWordRun[] | undefined;
	content: string;
}): TextWordRun[] | undefined {
	if (!wordRuns) return undefined;
	const lineIndexes = content.split("\n").flatMap((line, lineIndex) =>
		line
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(() => lineIndex),
	);
	return wordRuns.map((word, index) => ({
		...word,
		lineIndex: lineIndexes[index] ?? 0,
	}));
}
