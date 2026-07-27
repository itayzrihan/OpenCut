import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import type { EditorCore } from "@/core";
import {
	buildCaptionChunksFromWords,
	buildSubtitleCuesFromWords,
	splitCaptionCuesByLayer,
	stripCaptionPunctuation,
	type CaptionLayoutSettings,
} from "@/subtitles/caption-layout";
import { buildCaptionTextTracks } from "@/subtitles/insert";
import type { SceneTracks, TextElement, TextTrack } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import { normalizeTextFontWeight } from "@/text/primitives";
import type { TranscriptionWord } from "@/transcription/types";
import { generateUUID } from "@/utils/id";
import { mediaTimeToSeconds } from "@/wasm";

const TIMING_EPSILON_SECONDS = 0.002;
const SOURCE_SPAN_OVERLAP_RATIO = 0.6;

export interface CaptionElementRef {
	trackId: string;
	elementId: string;
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
	const candidate = track.captionSource;
	if (!candidate) return false;
	if (candidate.sourceId || source.sourceId) {
		return candidate.sourceId === source.sourceId;
	}

	const candidateWords = getGeneratedCaptionWords({ words: candidate.words });
	const sourceWords = getGeneratedCaptionWords({ words: source.words });
	if (candidateWords.length !== sourceWords.length) return false;
	if ((candidate.layerCount ?? 1) !== (source.layerCount ?? 1)) return false;

	const candidateSpan = captionSourceTimeSpan({ words: candidateWords });
	const sourceSpan = captionSourceTimeSpan({ words: sourceWords });
	if (!candidateSpan || !sourceSpan) return true;
	return (
		getSpanOverlapRatio({ left: candidateSpan, right: sourceSpan }) >=
		SOURCE_SPAN_OVERLAP_RATIO
	);
}

export function findCaptionSourceTrack({
	tracks,
}: {
	tracks: SceneTracks;
}): TextTrack | null {
	return (
		tracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		) ?? null
	);
}

export function findCaptionSourceTracks({
	tracks,
	source,
}: {
	tracks: SceneTracks;
	source: NonNullable<TextTrack["captionSource"]>;
}): TextTrack[] {
	return tracks.overlay.filter(
		(track): track is TextTrack =>
			track.type === "text" && hasSameCaptionSource({ track, source }),
	);
}

function textElementContent(element: TextElement) {
	return typeof element.params.content === "string"
		? element.params.content
		: "";
}

function isPristineGeneratedCaption({
	element,
	expected,
	settings,
}: {
	element: TextElement;
	expected: { text: string; startTime: number; duration: number } | undefined;
	settings: CaptionLayoutSettings;
}) {
	if (!expected) return false;
	const content = textElementContent(element);
	return (
		(content === expected.text ||
			(settings.hidePunctuation &&
				content === stripCaptionPunctuation({ text: expected.text }))) &&
		Math.abs(
			mediaTimeToSeconds({ time: element.startTime }) - expected.startTime,
		) <= TIMING_EPSILON_SECONDS &&
		Math.abs(
			mediaTimeToSeconds({ time: element.duration }) - expected.duration,
		) <= TIMING_EPSILON_SECONDS &&
		mediaTimeToSeconds({ time: element.trimStart }) === 0 &&
		mediaTimeToSeconds({ time: element.trimEnd }) === 0
	);
}

function buildEditedCaptionTracks({
	sourceTracks,
	ignoredElements = [],
}: {
	sourceTracks: TextTrack[];
	ignoredElements?: CaptionElementRef[];
}) {
	const ignoredElementKeys = new Set(
		ignoredElements.map(({ trackId, elementId }) => `${trackId}:${elementId}`),
	);

	return sourceTracks.flatMap((track) => {
		const source = track.captionSource;
		if (!source) return [];

		const previousCaptions = buildSubtitleCuesFromWords({
			words: getGeneratedCaptionWords({ words: source.words }),
			settings: source.settings,
		});
		const previousLayers = splitCaptionCuesByLayer({
			captions: previousCaptions,
			layerCount: source.layerCount ?? 1,
		});
		const expectedLayer = previousLayers[source.layerIndex ?? 0] ?? [];
		const editedElements = track.elements.filter(
			(element, index) =>
				!ignoredElementKeys.has(`${track.id}:${element.id}`) &&
				!isPristineGeneratedCaption({
					element,
					expected: expectedLayer[index],
					settings: source.settings,
				}),
		);

		if (editedElements.length === 0) return [];

		return [
			{
				...buildEmptyTrack({
					id: generateUUID(),
					type: "text",
					name: `Edited ${track.name}`,
				}),
				hidden: track.hidden,
				elements: editedElements,
			},
		];
	});
}

function findReusableCaptionElement({
	element,
	candidates,
	usedElementIds,
}: {
	element: TextElement;
	candidates: TextElement[];
	usedElementIds: Set<string>;
}): TextElement | null {
	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const elementDuration = mediaTimeToSeconds({ time: element.duration });

	return (
		candidates.find((candidate) => {
			if (usedElementIds.has(candidate.id)) return false;
			return (
				textElementContent(candidate) === textElementContent(element) &&
				Math.abs(
					mediaTimeToSeconds({ time: candidate.startTime }) - elementStart,
				) <= TIMING_EPSILON_SECONDS &&
				Math.abs(
					mediaTimeToSeconds({ time: candidate.duration }) - elementDuration,
				) <= TIMING_EPSILON_SECONDS
			);
		}) ?? null
	);
}

function elementTimeSpan(element: TextElement) {
	const start = mediaTimeToSeconds({ time: element.startTime });
	return {
		start,
		end: start + mediaTimeToSeconds({ time: element.duration }),
	};
}

function cueTimeSpan(cue: SubtitleCue) {
	return {
		start: cue.startTime,
		end: cue.startTime + cue.duration,
	};
}

function getOverlapSeconds({
	left,
	right,
}: {
	left: { start: number; end: number };
	right: { start: number; end: number };
}) {
	return Math.max(
		0,
		Math.min(left.end, right.end) - Math.max(left.start, right.start),
	);
}

function captionSourceTimeSpan({ words }: { words: TranscriptionWord[] }) {
	if (words.length === 0) return null;
	return words.reduce(
		(span, word) => ({
			start: Math.min(span.start, word.start),
			end: Math.max(span.end, word.end),
		}),
		{
			start: words[0].start,
			end: words[0].end,
		},
	);
}

function getSpanOverlapRatio({
	left,
	right,
}: {
	left: { start: number; end: number };
	right: { start: number; end: number };
}) {
	const leftDuration = Math.max(0, left.end - left.start);
	const rightDuration = Math.max(0, right.end - right.start);
	const shorterDuration = Math.min(leftDuration, rightDuration);
	if (shorterDuration <= TIMING_EPSILON_SECONDS) {
		return Math.abs(left.start - right.start) <= TIMING_EPSILON_SECONDS ? 1 : 0;
	}
	return getOverlapSeconds({ left, right }) / shorterDuration;
}

function findPresentationSourceElement({
	timeSpan,
	candidates,
}: {
	timeSpan: { start: number; end: number };
	candidates: TextElement[];
}): TextElement | null {
	let best: { element: TextElement; overlap: number; distance: number } | null =
		null;
	const midpoint = (timeSpan.start + timeSpan.end) / 2;

	for (const candidate of candidates) {
		const candidateTimeSpan = elementTimeSpan(candidate);
		const candidateMidpoint =
			(candidateTimeSpan.start + candidateTimeSpan.end) / 2;
		const overlap = getOverlapSeconds({
			left: timeSpan,
			right: candidateTimeSpan,
		});
		const distance = Math.abs(candidateMidpoint - midpoint);
		if (
			!best ||
			overlap > best.overlap ||
			(overlap === best.overlap && distance < best.distance)
		) {
			best = { element: candidate, overlap, distance };
		}
	}

	return best?.element ?? null;
}

function numberParam({
	params,
	key,
}: {
	params: TextElement["params"];
	key: string;
}): number | undefined {
	const value = params[key];
	return typeof value === "number" ? value : undefined;
}

function stringParam({
	params,
	key,
}: {
	params: TextElement["params"];
	key: string;
}): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function booleanParam({
	params,
	key,
}: {
	params: TextElement["params"];
	key: string;
}): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function textAlignParam({
	params,
}: {
	params: TextElement["params"];
}): SubtitleStyleOverrides["textAlign"] | undefined {
	const value = stringParam({ params, key: "textAlign" });
	return value === "left" || value === "center" || value === "right"
		? value
		: undefined;
}

function fontWeightParam({
	params,
}: {
	params: TextElement["params"];
}): SubtitleStyleOverrides["fontWeight"] | undefined {
	const value = stringParam({ params, key: "fontWeight" });
	return value === undefined
		? undefined
		: normalizeTextFontWeight({ value, fallback: "normal" });
}

function fontStyleParam({
	params,
}: {
	params: TextElement["params"];
}): SubtitleStyleOverrides["fontStyle"] | undefined {
	const value = stringParam({ params, key: "fontStyle" });
	return value === "italic" || value === "normal" ? value : undefined;
}

function textDecorationParam({
	params,
}: {
	params: TextElement["params"];
}): SubtitleStyleOverrides["textDecoration"] | undefined {
	const value = stringParam({ params, key: "textDecoration" });
	return value === "underline" || value === "line-through" || value === "none"
		? value
		: undefined;
}

function getElementStyleOverrides({
	element,
}: {
	element: TextElement;
}): SubtitleStyleOverrides {
	const params = element.params;
	return {
		fontFamily: stringParam({ params, key: "fontFamily" }),
		fontSize: numberParam({ params, key: "fontSize" }),
		color: stringParam({ params, key: "color" }),
		textAlign: textAlignParam({ params }),
		fontWeight: fontWeightParam({ params }),
		fontStyle: fontStyleParam({ params }),
		textDecoration: textDecorationParam({ params }),
		letterSpacing: numberParam({ params, key: "letterSpacing" }),
		lineHeight: numberParam({ params, key: "lineHeight" }),
		background: {
			enabled: booleanParam({ params, key: "background.enabled" }) ?? false,
			color: stringParam({ params, key: "background.color" }) ?? "#000000",
			cornerRadius: numberParam({ params, key: "background.cornerRadius" }),
			paddingX: numberParam({ params, key: "background.paddingX" }),
			paddingY: numberParam({ params, key: "background.paddingY" }),
			offsetX: numberParam({ params, key: "background.offsetX" }),
			offsetY: numberParam({ params, key: "background.offsetY" }),
		},
	};
}

function applyPresentationStylesToCaptions({
	captions,
	sourceTracks,
}: {
	captions: SubtitleCue[];
	sourceTracks: TextTrack[];
}): SubtitleCue[] {
	const sourceElements = sourceTracks.flatMap((track) => track.elements);
	if (sourceElements.length === 0) return captions;

	return captions.map((caption) => {
		const sourceElement = findPresentationSourceElement({
			timeSpan: cueTimeSpan(caption),
			candidates: sourceElements,
		});
		if (!sourceElement) return caption;
		return {
			...caption,
			style: {
				...caption.style,
				...getElementStyleOverrides({ element: sourceElement }),
			},
		};
	});
}

function mergeWordRunPresentation({
	generated,
	source,
}: {
	generated: TextElement["wordRuns"];
	source: TextElement["wordRuns"];
}): TextElement["wordRuns"] {
	if (!generated?.length || !source?.length) return generated;

	const usedSourceIndexes = new Set<number>();
	return generated.map((run, runIndex) => {
		const sourceIndex = source.findIndex(
			(sourceRun, candidateIndex) =>
				!usedSourceIndexes.has(candidateIndex) && sourceRun.text === run.text,
		);
		const fallbackIndex =
			sourceIndex >= 0
				? sourceIndex
				: runIndex < source.length && !usedSourceIndexes.has(runIndex)
					? runIndex
					: -1;
		const sourceRun = fallbackIndex >= 0 ? source[fallbackIndex] : undefined;
		if (!sourceRun) return run;
		usedSourceIndexes.add(fallbackIndex);
		return {
			...run,
			style: sourceRun.style,
			revealMode: sourceRun.revealMode,
			transitionIn: sourceRun.transitionIn,
			wordAnimationId: sourceRun.wordAnimationId,
			accentColor: sourceRun.accentColor,
			wordDirection: sourceRun.wordDirection,
		};
	});
}

function mergeCaptionElementPresentation({
	generated,
	source,
}: {
	generated: TextElement;
	source: TextElement;
}): TextElement {
	return {
		...generated,
		hidden: source.hidden ?? generated.hidden,
		effects: source.effects ?? generated.effects,
		animations: source.animations ?? generated.animations,
		transitions: source.transitions ?? generated.transitions,
		params: {
			...generated.params,
			...source.params,
			content: generated.params.content,
			"transform.positionX": generated.params["transform.positionX"],
			"transform.positionY": generated.params["transform.positionY"],
		},
		textRowOverrides: source.textRowOverrides ?? generated.textRowOverrides,
		wordRuns: mergeWordRunPresentation({
			generated: generated.wordRuns,
			source: source.wordRuns,
		}),
		captionRevealMode: source.captionRevealMode ?? generated.captionRevealMode,
		captionTransitionIn:
			source.captionTransitionIn ?? generated.captionTransitionIn,
		captionWordAnimationId:
			source.captionWordAnimationId ?? generated.captionWordAnimationId,
		captionAccentColor:
			source.captionAccentColor ?? generated.captionAccentColor,
		captionWordDirection:
			source.captionWordDirection ?? generated.captionWordDirection,
	};
}

function applyStableCaptionIdentity({
	regeneratedTracks,
	sourceTracks,
	preferredElementRefs = [],
}: {
	regeneratedTracks: TextTrack[];
	sourceTracks: TextTrack[];
	preferredElementRefs?: CaptionElementRef[];
}): TextTrack[] {
	const reusableElements = sourceTracks.flatMap((track) => track.elements);
	const sourceTrackById = new Map(
		sourceTracks.map((track) => [track.id, track]),
	);
	const sourceTrackIdByElementId = new Map(
		sourceTracks.flatMap((track) =>
			track.elements.map((element) => [element.id, track.id] as const),
		),
	);
	const preferredElementIds = new Set(
		preferredElementRefs.map(({ elementId }) => elementId),
	);
	const usedElementIds = new Set<string>();
	const matchedElementIdsByTrackIndex = new Map<number, string[]>();

	const tracksWithStableElements = regeneratedTracks.map(
		(track, trackIndex) => ({
			...track,
			elements: track.elements.map((element) => {
				const reusable = findReusableCaptionElement({
					element,
					candidates: reusableElements,
					usedElementIds,
				});
				const presentationSource =
					reusable ??
					findPresentationSourceElement({
						timeSpan: elementTimeSpan(element),
						candidates: reusableElements,
					});
				const elementWithPresentation = presentationSource
					? mergeCaptionElementPresentation({
							generated: element,
							source: presentationSource,
						})
					: element;
				if (!reusable) return elementWithPresentation;
				usedElementIds.add(reusable.id);
				matchedElementIdsByTrackIndex.set(trackIndex, [
					...(matchedElementIdsByTrackIndex.get(trackIndex) ?? []),
					reusable.id,
				]);
				return {
					...elementWithPresentation,
					id: reusable.id,
					name: reusable.name,
				};
			}),
		}),
	);

	const usedTrackIds = new Set<string>();
	const assignedTrackIds = new Map<number, string>();

	for (const [trackIndex, elementIds] of matchedElementIdsByTrackIndex) {
		const preferredTrackId = elementIds
			.filter((elementId) => preferredElementIds.has(elementId))
			.map((elementId) => sourceTrackIdByElementId.get(elementId))
			.find(
				(trackId): trackId is string => !!trackId && !usedTrackIds.has(trackId),
			);
		if (!preferredTrackId) continue;
		assignedTrackIds.set(trackIndex, preferredTrackId);
		usedTrackIds.add(preferredTrackId);
	}

	return tracksWithStableElements.map((track, trackIndex) => {
		const fallbackTrackId = !usedTrackIds.has(
			sourceTracks[trackIndex]?.id ?? "",
		)
			? sourceTracks[trackIndex]?.id
			: sourceTracks.find((sourceTrack) => !usedTrackIds.has(sourceTrack.id))
					?.id;
		const assignedTrackId = assignedTrackIds.get(trackIndex) ?? fallbackTrackId;
		if (assignedTrackId) {
			usedTrackIds.add(assignedTrackId);
		}
		const previousTrack = assignedTrackId
			? sourceTrackById.get(assignedTrackId)
			: undefined;
		return {
			...track,
			id: assignedTrackId ?? track.id,
			name: previousTrack?.name ?? track.name,
			hidden: previousTrack?.hidden ?? track.hidden,
		};
	});
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

export function rebuildCaptionTracksWithSource({
	tracks,
	words,
	settings,
	canvasSize,
	layerCount,
	ignoredEditedElements,
	preserveEditedElements = true,
}: {
	tracks: SceneTracks;
	words: TranscriptionWord[];
	settings: CaptionLayoutSettings;
	canvasSize: { width: number; height: number };
	layerCount?: number;
	ignoredEditedElements?: CaptionElementRef[];
	preserveEditedElements?: boolean;
}): SceneTracks | null {
	const firstSourceTrack = findCaptionSourceTrack({ tracks });
	const source = firstSourceTrack?.captionSource;
	if (!source) return null;

	const sourceTracks = findCaptionSourceTracks({ tracks, source });
	const sourceTrackIds = new Set(sourceTracks.map((track) => track.id));
	const editedTracks = preserveEditedElements
		? buildEditedCaptionTracks({
				sourceTracks,
				ignoredElements: ignoredEditedElements,
			})
		: [];
	const captions = applyPresentationStylesToCaptions({
		captions: buildCaptionChunksFromWords({
			words: getGeneratedCaptionWords({ words }),
			settings,
		}),
		sourceTracks,
	});
	const regeneratedTracks = buildCaptionTextTracks({
		captions,
		captionSource: {
			...source,
			words,
			settings,
		},
		layerCount: layerCount ?? source.layerCount ?? 1,
		canvasSize,
	});
	const stableRegeneratedTracks = applyStableCaptionIdentity({
		regeneratedTracks,
		sourceTracks,
		preferredElementRefs: ignoredEditedElements,
	});

	return {
		...tracks,
		overlay: [
			...stableRegeneratedTracks,
			...editedTracks,
			...tracks.overlay.filter((track) => !sourceTrackIds.has(track.id)),
		],
	};
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
