import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import type { EditorCore } from "@/core";
import type { SceneTracks, TextTrack } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import type { TranscriptionWord } from "@/transcription/types";
import type { CaptionLayoutSettings } from "./caption-layout";
import { generateUUID } from "@/utils/id";
import { DEFAULTS } from "@/timeline/defaults";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { setCanvasLetterSpacing } from "@/text/layout";
import {
	planCaptionSourceSelection,
	rebuildCaptionScene,
	type CaptionTextMeasureQuery,
} from "opencut-wasm";

export interface CaptionElementRef {
	trackId: string;
	elementId: string;
}
interface CaptionSourceSelection {
	firstIndex: number | null;
	indices: number[];
	matches: boolean;
}
function sourceSelection(input: unknown): CaptionSourceSelection {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Rust supplies source membership and validated overlay indices.
	return JSON.parse(
		planCaptionSourceSelection({ inputJson: JSON.stringify(input) }),
	) as CaptionSourceSelection;
}
export function isTextLayerTranscriptionWord({
	word,
}: {
	word: TranscriptionWord;
}) {
	return word.source?.type === "text-layer";
}
export function getGeneratedCaptionWords({
	words,
}: {
	words: TranscriptionWord[];
}) {
	return words.filter((word) => !isTextLayerTranscriptionWord({ word }));
}
export function hasSameCaptionSource({
	track,
	source,
}: {
	track: TextTrack;
	source: NonNullable<TextTrack["captionSource"]>;
}) {
	return sourceSelection({ track, source }).matches;
}
export function findCaptionSourceTrack({
	tracks,
}: {
	tracks: SceneTracks;
}): TextTrack | null {
	const index = sourceSelection({ tracks }).firstIndex;
	if (index === null) return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The Rust selector only returns text tracks carrying a caption source.
	return tracks.overlay[index] as TextTrack;
}
export function findCaptionSourceTracks({
	tracks,
	source,
}: {
	tracks: SceneTracks;
	source: NonNullable<TextTrack["captionSource"]>;
}): TextTrack[] {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Rust source-group indices refer only to matching text tracks.
	return sourceSelection({ tracks, source }).indices.map(
		(index) => tracks.overlay[index],
	) as TextTrack[];
}
function pointerKey(key: string): string {
	return key.replaceAll("~1", "/").replaceAll("~0", "~");
}
function referenceAt({
	root,
	pointer,
}: {
	root: unknown;
	pointer: string;
}): unknown {
	let value: unknown = root;
	if (!pointer) return value;
	for (const part of pointer.slice(1).split("/")) {
		const key = pointerKey(part);
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
			throw new Error("Invalid shared caption reference source");
		value = Reflect.get(value, key);
	}
	return value;
}
interface CaptionScenePlan {
	tracks: SceneTracks | null;
	references: { from: "input"; source: string; target: string }[];
}

function areCaptionWordsEqual({
	left,
	right,
}: {
	left: TranscriptionWord[];
	right: TranscriptionWord[];
}) {
	if (left.length !== right.length) return false;
	return left.every((word, index) => {
		const candidate = right[index];
		if (!candidate) return false;
		return (
			word.text === candidate.text &&
			word.start === candidate.start &&
			word.end === candidate.end
		);
	});
}

export function rebuildCaptionTracksWithSource(input: {
	tracks: SceneTracks;
	words: TranscriptionWord[];
	settings: CaptionLayoutSettings;
	canvasSize: { width: number; height: number };
	layerCount?: number;
	ignoredEditedElements?: CaptionElementRef[];
	preserveEditedElements?: boolean;
}): SceneTracks | null {
	if (sourceSelection({ tracks: input.tracks }).firstIndex === null)
		return null;
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
	const request = {
		...input,
		defaults: DEFAULTS.text,
		fontSizeScaleReference: FONT_SIZE_SCALE_REFERENCE,
		trackDefaults: buildEmptyTrack({ id: "", type: "text" }),
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Rust builds the complete scene and a reference plan; this adapter only restores selected host object identities.
	const plan = JSON.parse(
		rebuildCaptionScene({
			inputJson: JSON.stringify(request, (_key, value) =>
				typeof value === "number" && !Number.isFinite(value)
					? { nonFinite: true }
					: value,
			),
			freshId: generateUUID,
			measure,
		}),
	) as CaptionScenePlan;
	if (!plan.tracks) return null;
	for (const binding of plan.references) {
		const value = referenceAt({ root: input, pointer: binding.source });
		const slash = binding.target.lastIndexOf("/");
		const parent = referenceAt({
			root: plan.tracks,
			pointer: binding.target.slice(0, slash),
		});
		const key = pointerKey(binding.target.slice(slash + 1));
		if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
			throw new Error("Invalid shared caption reference target");
		Reflect.set(parent, key, value);
	}
	return plan.tracks;
}

export function updateCaptionSourceWords({
	editor,
	words,
	settings,
}: {
	editor: EditorCore;
	words: TranscriptionWord[];
	settings?: CaptionLayoutSettings;
}) {
	const activeScene = editor.scenes.getActiveSceneOrNull();
	if (!activeScene) return false;
	const sourceTrack = findCaptionSourceTrack({ tracks: activeScene.tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return false;
	const nextSettings = settings ?? source.settings;
	if (
		nextSettings === source.settings &&
		areCaptionWordsEqual({ left: source.words, right: words })
	) {
		return false;
	}
	const after = rebuildCaptionTracksWithSource({
		tracks: activeScene.tracks,
		words,
		settings: nextSettings,
		canvasSize: editor.project.getActive().settings.canvasSize,
		layerCount: source.layerCount,
		preserveEditedElements: false,
	});
	if (!after) return false;
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before: activeScene.tracks,
			after,
		}),
	});
	return true;
}
