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
import {
	buildCaptionCuePlan,
	allocateCaptionLayers,
	normalizeCaptionLayoutSettings as normalizeCaptionLayoutSettingsRust,
} from "opencut-wasm";

export type CaptionPlacementMode = "grid" | "manual";

export const DEFAULT_CAPTION_LAYOUT = {
	wordsPerRow: 4,
	rows: 1,
	inPaddingPercent: 0,
	outPaddingPercent: 0,
	bottomFadeOutPercent: 60,
	revealMode: "determined-by-preset" as TextCaptionRevealMode,
	transitionIn: "none" as TextWordTransitionIn,
	wordAnimationId: "none",
	accentColor: "#c8ff4d",
	wordDirection: "auto" as TextWordDirection,
	hidePunctuation: true,
	placementMode: "grid" as CaptionPlacementMode,
	placementGridX: 0.5,
	placementGridY: 0.5,
	manualPositionX: 0,
	manualPositionY: 0,
};

export interface CaptionLayoutSettings {
	wordsPerRow: number;
	rows: number;
	/**
	 * Optional end-exclusive word positions for semantic caption rows.
	 * When present, rows are still capped by wordsPerRow and grouped into
	 * captions according to the configured rows value.
	 */
	rowBreaks?: number[];
	/** Preserve source word clocks when captions follow a take assembly. */
	exactWordTimings?: boolean;
	/** End-exclusive word indexes of source edits; cues cannot cross them. */
	segmentBreaks?: number[];
	inPaddingPercent: number;
	outPaddingPercent: number;
	/**
	 * Percentage of the caption height feathered to transparent at the bottom.
	 * Optional so caption sources saved before this setting remain unchanged.
	 */
	bottomFadeOutPercent?: number;
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

export function stripCaptionPunctuation({ text }: { text: string }): string {
	return text
		.replace(/(?![?¿؟？])\p{P}/gu, "")
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
	// Rust validates every returned field; this is only the JSON host adapter.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The shared Rust normalizer constructs this complete validated contract.
	return JSON.parse(
		normalizeCaptionLayoutSettingsRust({
			settingsJson: encodeSettings(settings),
		}),
	) as CaptionLayoutSettings;
}

function encodeSettings(settings: unknown): string {
	return JSON.stringify(settings ?? {}, (_key, value) =>
		typeof value === "number" && !Number.isFinite(value)
			? { nonFinite: true }
			: value,
	);
}

export function resolveCaptionBottomFadeOut({
	settings,
}: {
	settings: CaptionLayoutSettings | undefined;
}): number {
	if (typeof settings?.bottomFadeOutPercent !== "number")
		return DEFAULT_CAPTION_LAYOUT.bottomFadeOutPercent / 100;
	return (
		clampNumber({
			value: settings.bottomFadeOutPercent,
			min: 0,
			max: 100,
		}) / 100
	);
}

export function buildCaptionChunksFromWords({
	words,
	settings,
}: {
	words: TranscriptionWord[];
	settings: CaptionLayoutSettings;
}): CaptionChunk[] {
	return buildCaptionCuePlan({
		words: words.map(({ text, start, end }) => ({ text, start, end })),
		settingsJson: encodeSettings(settings),
	}).map((cue) => ({
		text: cue.text,
		startTime: cue.startTime,
		duration: cue.duration,
		words: cue.wordIndices.map((index) => words[index]),
	}));
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
	return allocateCaptionLayers({
		captions: captions.map(({ text, startTime, duration }) => ({
			text,
			startTime,
			duration,
			wordIndices: [],
		})),
		layerCount,
	}).layers.map((layer) => layer.map((index) => captions[index]));
}
