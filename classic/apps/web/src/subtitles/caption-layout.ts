import type {
	CaptionChunk,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";
import type { SubtitleCue } from "./types";
import type {
	TextCaptionRevealMode,
	TextWordDirection,
	TextWordTransitionIn,
} from "@/timeline";

export type CaptionPlacementMode = "grid" | "manual";

export const DEFAULT_CAPTION_LAYOUT = {
	wordsPerRow: 4,
	rows: 2,
	inPaddingPercent: 0,
	outPaddingPercent: 0,
	revealMode: "determined-by-preset" as TextCaptionRevealMode,
	transitionIn: "none" as TextWordTransitionIn,
	wordAnimationId: "none",
	accentColor: "#c8ff4d",
	wordDirection: "auto" as TextWordDirection,
	hidePunctuation: false,
	placementMode: "grid" as CaptionPlacementMode,
	placementGridX: 0.5,
	placementGridY: 1,
	manualPositionX: 0,
	manualPositionY: 0,
};

export interface CaptionLayoutSettings {
	wordsPerRow: number;
	rows: number;
	inPaddingPercent: number;
	outPaddingPercent: number;
	revealMode: TextCaptionRevealMode;
	transitionIn: TextWordTransitionIn;
	wordAnimationId: string;
	accentColor: string;
	wordDirection: TextWordDirection;
	hidePunctuation: boolean;
	placementMode: CaptionPlacementMode;
	placementGridX: number;
	placementGridY: number;
	manualPositionX: number;
	manualPositionY: number;
}

type LegacyCaptionLayoutSettings = Partial<CaptionLayoutSettings> & {
	presetId?: string;
};

function clampInteger({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

function isPlacementMode(value: unknown): value is CaptionPlacementMode {
	return value === "grid" || value === "manual";
}

export function stripCaptionPunctuation({ text }: { text: string }): string {
	return text
		.replace(/\p{P}+/gu, "")
		.replace(/[^\S\n]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function getCaptionPlacementGrid({
	canvasSize,
}: {
	canvasSize: { width: number; height: number };
}): { columns: number; rows: number } {
	const width = Math.max(1, canvasSize.width);
	const height = Math.max(1, canvasSize.height);
	const ratio = width / height;

	if (Math.abs(ratio - 1) <= 0.05) {
		return { columns: 3, rows: 3 };
	}

	if (ratio > 1) {
		return { columns: 5, rows: 3 };
	}

	return { columns: 3, rows: 5 };
}

export function getCaptionGridCell({
	settings,
	canvasSize,
}: {
	settings: CaptionLayoutSettings;
	canvasSize: { width: number; height: number };
}): { columnIndex: number; rowIndex: number; columns: number; rows: number } {
	const grid = getCaptionPlacementGrid({ canvasSize });
	const columnIndex = clampInteger({
		value: settings.placementGridX * Math.max(0, grid.columns - 1),
		min: 0,
		max: grid.columns - 1,
	});
	const rowIndex = clampInteger({
		value: settings.placementGridY * Math.max(0, grid.rows - 1),
		min: 0,
		max: grid.rows - 1,
	});

	return {
		...grid,
		columnIndex,
		rowIndex,
	};
}

export function normalizeCaptionLayoutSettings({
	settings,
}: {
	settings: LegacyCaptionLayoutSettings | undefined;
}): CaptionLayoutSettings {
	const revealMode =
		settings?.revealMode === "determined-by-preset" ||
		settings?.revealMode === "row" ||
		settings?.revealMode === "spoken-word" ||
		settings?.revealMode === "spoken-word-keep" ||
		settings?.revealMode === "emphasize-spoken" ||
		settings?.revealMode === "emphasize-spoken-keep" ||
		settings?.revealMode === "letter-by-letter" ||
		settings?.revealMode === "growing-row"
			? settings.revealMode
			: DEFAULT_CAPTION_LAYOUT.revealMode;
	const transitionIn =
		settings?.transitionIn === "none" ||
		settings?.transitionIn === "fade" ||
		settings?.transitionIn === "blur" ||
		settings?.transitionIn === "zoom" ||
		settings?.transitionIn === "blur-zoom" ||
		settings?.transitionIn === "rise" ||
		settings?.transitionIn === "slide" ||
		settings?.transitionIn === "typewriter" ||
		settings?.transitionIn === "glow-dissolve"
			? settings.transitionIn
			: DEFAULT_CAPTION_LAYOUT.transitionIn;
	const wordDirection =
		settings?.wordDirection === "ltr" ||
		settings?.wordDirection === "rtl" ||
		settings?.wordDirection === "auto"
			? settings.wordDirection
			: DEFAULT_CAPTION_LAYOUT.wordDirection;
	const placementMode = isPlacementMode(settings?.placementMode)
		? settings.placementMode
		: DEFAULT_CAPTION_LAYOUT.placementMode;
	return {
		wordsPerRow: clampInteger({
			value: settings?.wordsPerRow ?? DEFAULT_CAPTION_LAYOUT.wordsPerRow,
			min: 1,
			max: 12,
		}),
		rows: clampInteger({
			value: settings?.rows ?? DEFAULT_CAPTION_LAYOUT.rows,
			min: 1,
			max: 4,
		}),
		inPaddingPercent: clampNumber({
			value:
				settings?.inPaddingPercent ?? DEFAULT_CAPTION_LAYOUT.inPaddingPercent,
			min: 0,
			max: 100,
		}),
		outPaddingPercent: clampNumber({
			value:
				settings?.outPaddingPercent ?? DEFAULT_CAPTION_LAYOUT.outPaddingPercent,
			min: 0,
			max: 100,
		}),
		revealMode,
		transitionIn,
		wordAnimationId:
			typeof settings?.wordAnimationId === "string" &&
			settings.wordAnimationId.trim()
				? settings.wordAnimationId
				: typeof settings?.presetId === "string" && settings.presetId.trim()
					? settings.presetId
					: DEFAULT_CAPTION_LAYOUT.wordAnimationId,
		accentColor:
			typeof settings?.accentColor === "string" && settings.accentColor.trim()
				? settings.accentColor
				: DEFAULT_CAPTION_LAYOUT.accentColor,
		wordDirection,
		hidePunctuation:
			typeof settings?.hidePunctuation === "boolean"
				? settings.hidePunctuation
				: DEFAULT_CAPTION_LAYOUT.hidePunctuation,
		placementMode,
		placementGridX: clampNumber({
			value: settings?.placementGridX ?? DEFAULT_CAPTION_LAYOUT.placementGridX,
			min: 0,
			max: 1,
		}),
		placementGridY: clampNumber({
			value: settings?.placementGridY ?? DEFAULT_CAPTION_LAYOUT.placementGridY,
			min: 0,
			max: 1,
		}),
		manualPositionX: clampNumber({
			value:
				settings?.manualPositionX ?? DEFAULT_CAPTION_LAYOUT.manualPositionX,
			min: -100_000,
			max: 100_000,
		}),
		manualPositionY: clampNumber({
			value:
				settings?.manualPositionY ?? DEFAULT_CAPTION_LAYOUT.manualPositionY,
			min: -100_000,
			max: 100_000,
		}),
	};
}

function paddedCaptionTime({
	startTime,
	endTime,
	settings,
}: {
	startTime: number;
	endTime: number;
	settings: CaptionLayoutSettings;
}) {
	const duration = Math.max(0.001, endTime - startTime);
	const paddedStart = Math.max(
		0,
		startTime - duration * (settings.inPaddingPercent / 100),
	);
	const paddedEnd = endTime + duration * (settings.outPaddingPercent / 100);
	return {
		startTime: paddedStart,
		endTime: Math.max(paddedEnd, paddedStart + 0.001),
	};
}

export function buildCaptionChunksFromWords({
	words,
	settings,
}: {
	words: TranscriptionWord[];
	settings: CaptionLayoutSettings;
}): CaptionChunk[] {
	const normalized = normalizeCaptionLayoutSettings({ settings });
	const wordsPerCaption = normalized.wordsPerRow * normalized.rows;
	const captions: CaptionChunk[] = [];

	for (let i = 0; i < words.length; i += wordsPerCaption) {
		const group = words.slice(i, i + wordsPerCaption);
		if (group.length === 0) continue;

		const lines: string[] = [];
		for (
			let lineStart = 0;
			lineStart < group.length;
			lineStart += normalized.wordsPerRow
		) {
			lines.push(
				group
					.slice(lineStart, lineStart + normalized.wordsPerRow)
					.map((word) => word.text)
					.join(" "),
			);
		}

		const rawStartTime = group[0].start;
		const rawEndTime = Math.max(
			group[group.length - 1].end,
			rawStartTime + 0.1,
		);
		const { startTime, endTime } = paddedCaptionTime({
			startTime: rawStartTime,
			endTime: rawEndTime,
			settings: normalized,
		});
		captions.push({
			text: lines.join("\n"),
			startTime,
			duration: endTime - startTime,
			words: group,
		});
	}

	return captions;
}

export function buildCaptionChunksFromSegments({
	segments,
	settings,
}: {
	segments: TranscriptionSegment[];
	settings: CaptionLayoutSettings;
}): CaptionChunk[] {
	const words = segments.flatMap((segment) => {
		const parts = segment.text.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return [];
		const duration = Math.max(0.1, segment.end - segment.start);
		const wordDuration = duration / parts.length;
		return parts.map((text, index) => ({
			text,
			start: segment.start + index * wordDuration,
			end: segment.start + (index + 1) * wordDuration,
		}));
	});
	return buildCaptionChunksFromWords({ words, settings });
}

export function buildSubtitleCuesFromWords({
	words,
	settings,
}: {
	words: TranscriptionWord[];
	settings: CaptionLayoutSettings;
}): SubtitleCue[] {
	return buildCaptionChunksFromWords({ words, settings });
}

export function splitCaptionCuesByLayer({
	captions,
	layerCount,
}: {
	captions: SubtitleCue[];
	layerCount: number;
}): SubtitleCue[][] {
	const safeLayerCount = clampInteger({ value: layerCount, min: 1, max: 16 });
	const layers = Array.from(
		{ length: safeLayerCount },
		() => [] as SubtitleCue[],
	);
	const layerEnds = Array.from({ length: safeLayerCount }, () => 0);

	captions.forEach((caption, index) => {
		const captionEnd = caption.startTime + caption.duration;
		const preferredLayerIndex = index % safeLayerCount;
		let layerIndex = preferredLayerIndex;

		if (layerEnds[layerIndex] > caption.startTime) {
			layerIndex = layerEnds.findIndex(
				(end, candidateIndex) =>
					candidateIndex < safeLayerCount && end <= caption.startTime,
			);
		}

		if (layerIndex === -1) {
			layerIndex = layers.length;
			layers.push([]);
			layerEnds.push(0);
		}
		layers[layerIndex].push(caption);
		layerEnds[layerIndex] = Math.max(layerEnds[layerIndex], captionEnd);
	});

	return layers.filter((layer) => layer.length > 0);
}
