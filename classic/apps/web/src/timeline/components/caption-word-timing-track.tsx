"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import {
	useEditor,
	useEditorSelection,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import {
	findCaptionSourceTrack,
	findCaptionSourceTracks,
	updateCaptionSourceWords,
} from "@/subtitles/caption-tracks";
import type { SelectedTextWordRef } from "@/selection/editor-selection";
import type { TextElement, TextTrack } from "@/timeline/types";
import {
	getTimelinePixelsPerSecond,
	timelineTimeToPixels,
} from "@/timeline/pixel-utils";
import type { TranscriptionWord } from "@/transcription/types";
import { cn } from "@/utils/ui";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import {
	getCaptionWordVisibilityIndex,
	getVisibleCaptionWordIndexes,
	getVisibleWordTiming,
	WORD_TIMING_MIN_WORD_WIDTH_PX,
	type WordDragPreview,
} from "./caption-word-visibility";
import {
	buildTextElementWordDeletePatch,
	buildTextElementWordInsertPatch,
	buildTextElementWordUpdates,
} from "./caption-word-updates";
import {
	findWordIndexForRun,
	getWordElementRefs,
	isTimedWordRun,
} from "./caption-word-element-refs";

export { getWordElementRefs } from "./caption-word-element-refs";

export const CAPTION_WORD_TIMING_TRACK_HEIGHT_PX = 42;
const CAPTION_WORD_TIMING_LANE_HEIGHT_PX = 24;
const CAPTION_WORD_TIMING_VERTICAL_PADDING_PX = 8;
const WORD_TIMING_HORIZONTAL_OVERSCAN_PX = 800;

type WordDragMode = "move" | "left" | "right";

const WORD_DRAG_THRESHOLD_PX = 2;

export function getCaptionWordTimingTrackHeight({
	laneCount,
}: {
	laneCount: number;
}) {
	return Math.max(
		CAPTION_WORD_TIMING_TRACK_HEIGHT_PX,
		CAPTION_WORD_TIMING_VERTICAL_PADDING_PX +
			Math.max(1, laneCount) * CAPTION_WORD_TIMING_LANE_HEIGHT_PX,
	);
}

export function getCaptionWordTimingTrackHeightForWords({
	words,
}: {
	words: TranscriptionWord[];
}) {
	return getCaptionWordTimingTrackHeight({
		laneCount: getCaptionWordTimingLaneCount({ words }),
	});
}

interface WordCoverageIssue {
	key: string;
	wordIndex: number;
	side: "left" | "right";
	time: number;
	element: TextElement;
	track: TextTrack;
}

interface CaptionWordTimingTrackProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	scrollLeft: number;
	viewportWidth: number;
	onMouseDown?: (event: React.MouseEvent) => void;
	onMouseUp?: (event: React.MouseEvent) => void;
	onHeightChange?: ({ height }: { height: number }) => void;
}

export function CaptionWordTimingTrack({
	zoomLevel,
	dynamicTimelineWidth,
	scrollLeft,
	viewportWidth,
	onMouseDown,
	onMouseUp,
	onHeightChange,
}: CaptionWordTimingTrackProps) {
	const editor = useEditor();
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const selectedTextWords = useEditorSelection((e) =>
		e.selection.getSelectedTextWords(),
	);
	const setActivePropertiesTab = usePropertiesStore(
		(state) => state.setActiveTab,
	);
	const rowRef = useRef<HTMLDivElement>(null);
	const dragPreviewRef = useRef<WordDragPreview | null>(null);
	const didWordDragRef = useRef(false);
	const [dragPreview, setDragPreview] = useState<WordDragPreview | null>(null);

	const sourceTrack = useMemo(
		() => (scene ? findCaptionSourceTrack({ tracks: scene.tracks }) : null),
		[scene],
	);
	const source = sourceTrack?.captionSource;
	const words = useMemo(() => source?.words ?? [], [source]);

	const sourceTracks = useMemo(
		() =>
			scene && source
				? findCaptionSourceTracks({
						tracks: scene.tracks,
						source,
					})
				: [],
		[scene, source],
	);

	const issues = useMemo(
		() =>
			scene && sourceTrack
				? getWordCoverageIssues({
						words,
						sourceTrack,
						sourceTracks,
					})
				: [],
		[scene, sourceTrack, sourceTracks, words],
	);

	const wordElementRefs = useMemo(
		() => getWordElementRefs({ words, sourceTracks }),
		[words, sourceTracks],
	);
	const wordStructureElementRefs = useMemo(
		() =>
			getWordElementRefs({
				words,
				sourceTracks,
				includePresentationOnly: true,
			}),
		[words, sourceTracks],
	);
	const selectedTextWordKeys = useMemo(
		() => new Set(selectedTextWords.map(getSelectedTextWordKey)),
		[selectedTextWords],
	);
	const wordLayouts = useMemo(
		() => buildWordLayouts({ words, dragPreview }),
		[words, dragPreview],
	);
	const wordVisibilityIndex = useMemo(
		() => getCaptionWordVisibilityIndex({ words }),
		[words],
	);
	const visibleWordIndexes = useMemo(() => {
		if (viewportWidth <= 0) {
			return words.map((_, index) => index);
		}

		return getVisibleCaptionWordIndexes({
			words,
			dragPreview,
			visibleWindow: {
				start: Math.max(0, scrollLeft - WORD_TIMING_HORIZONTAL_OVERSCAN_PX),
				end: scrollLeft + viewportWidth + WORD_TIMING_HORIZONTAL_OVERSCAN_PX,
			},
			zoomLevel,
			visibilityIndex: wordVisibilityIndex,
		});
	}, [
		dragPreview,
		scrollLeft,
		viewportWidth,
		wordVisibilityIndex,
		words,
		zoomLevel,
	]);
	const wordTimingLaneCount = useMemo(
		() => getCaptionWordTimingLaneCount({ words, dragPreview }),
		[words, dragPreview],
	);
	const wordTimingTrackHeight = getCaptionWordTimingTrackHeight({
		laneCount: wordTimingLaneCount,
	});

	useEffect(() => {
		onHeightChange?.({ height: wordTimingTrackHeight });
	}, [onHeightChange, wordTimingTrackHeight]);

	const commitWords = useCallback(
		(nextWords: TranscriptionWord[]) => {
			if (!source) return;
			updateCaptionSourceWords({
				editor,
				words: nextWords,
				settings: source.settings,
			});
		},
		[editor, source],
	);

	const updateVisibleTextLayerWord = useCallback(
		({
			wordIndex,
			currentWord,
			nextWord,
		}: {
			wordIndex: number;
			currentWord: TranscriptionWord;
			nextWord: TranscriptionWord;
		}) => {
			if (!scene) return false;
			const updates = buildTextElementWordUpdates({
				tracks: scene.tracks,
				refs:
					nextWord.text !== currentWord.text &&
					nextWord.start === currentWord.start &&
					nextWord.end === currentWord.end
						? (wordStructureElementRefs.get(wordIndex) ?? [])
						: (wordElementRefs.get(wordIndex) ?? []),
				currentWord,
				nextWord,
			});
			if (updates.length === 0) return false;

			editor.timeline.updateElements({ updates });
			return true;
		},
		[editor, scene, wordElementRefs, wordStructureElementRefs],
	);

	const updateWord = useCallback(
		({
			wordIndex,
			update,
		}: {
			wordIndex: number;
			update: (word: TranscriptionWord) => TranscriptionWord;
		}) => {
			const current = words[wordIndex];
			if (!current) return;
			const nextWord = update(current);
			if (areTranscriptionWordsEqual({ left: current, right: nextWord }))
				return;
			if (
				updateVisibleTextLayerWord({
					wordIndex,
					currentWord: current,
					nextWord,
				})
			) {
				return;
			}
			commitWords(
				words.map((word, index) => (index === wordIndex ? nextWord : word)),
			);
		},
		[commitWords, updateVisibleTextLayerWord, words],
	);

	const updateVisibleTextLayerWordStructure = useCallback(
		({
			wordIndex,
			buildPatch,
		}: {
			wordIndex: number;
			buildPatch: ({
				element,
				wordIndex,
			}: {
				element: TextElement;
				wordIndex: number;
			}) => Partial<TextElement> | null;
		}) => {
			if (!scene) return false;
			const updates = (wordStructureElementRefs.get(wordIndex) ?? []).flatMap(
				(ref) => {
					const track = scene.tracks.overlay.find(
						(candidate): candidate is TextTrack =>
							candidate.type === "text" && candidate.id === ref.trackId,
					);
					const element = track?.elements.find(
						(candidate) => candidate.id === ref.elementId,
					);
					if (!track || !element) return [];
					const localWordIndex = (element.wordRuns ?? []).findIndex(
						(run) => run.id === ref.wordId,
					);
					const patch = buildPatch({
						element,
						wordIndex: localWordIndex >= 0 ? localWordIndex : wordIndex,
					});
					return patch
						? [
								{
									trackId: track.id,
									elementId: element.id,
									patch,
								},
							]
						: [];
				},
			);
			if (updates.length === 0) return false;
			editor.timeline.updateElements({ updates });
			return true;
		},
		[editor, scene, wordStructureElementRefs],
	);

	const removeWord = useCallback(
		({ wordIndex }: { wordIndex: number }) => {
			if (!words[wordIndex]) return;
			if (
				updateVisibleTextLayerWordStructure({
					wordIndex,
					buildPatch: ({ element, wordIndex: localWordIndex }) =>
						buildTextElementWordDeletePatch({
							element,
							wordIndex: localWordIndex,
						}),
				})
			) {
				return;
			}
			commitWords(words.filter((_, index) => index !== wordIndex));
		},
		[commitWords, updateVisibleTextLayerWordStructure, words],
	);

	const insertWord = useCallback(
		({
			wordIndex,
			position,
		}: {
			wordIndex: number;
			position: "before" | "after";
		}) => {
			const text = window.prompt("Add transcript word");
			if (text === null) return;
			const trimmed = text.trim();
			if (!trimmed) return;
			const insertIndex = position === "before" ? wordIndex : wordIndex + 1;
			if (
				updateVisibleTextLayerWordStructure({
					wordIndex,
					buildPatch: ({ element, wordIndex: localWordIndex }) =>
						buildTextElementWordInsertPatch({
							element,
							insertIndex:
								position === "before" ? localWordIndex : localWordIndex + 1,
							text: trimmed,
						}),
				})
			) {
				return;
			}

			const previous = words[insertIndex - 1];
			const next = words[insertIndex];
			const start =
				previous && next
					? previous.end < next.start
						? previous.end + (next.start - previous.end) / 2
						: (previous.end + next.start) / 2
					: previous
						? previous.end
						: next
							? next.start
							: 0;
			const safeStart = roundSeconds(Math.max(0, start));
			const inserted: TranscriptionWord = {
				text: trimmed,
				start: safeStart,
				end: roundSeconds(safeStart + 0.01),
			};
			commitWords([
				...words.slice(0, insertIndex),
				inserted,
				...words.slice(insertIndex),
			]);
		},
		[commitWords, updateVisibleTextLayerWordStructure, words],
	);

	const beginWordDrag = useCallback(
		({
			event,
			wordIndex,
			mode,
		}: {
			event: React.MouseEvent;
			wordIndex: number;
			mode: WordDragMode;
		}) => {
			const word = words[wordIndex];
			if (!word || !rowRef.current) return;
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();

			const startClientX = event.clientX;
			const startWord = { start: word.start, end: word.end };
			const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
			let latestPreview: WordDragPreview = { wordIndex, ...startWord };
			let hasMoved = false;
			dragPreviewRef.current = latestPreview;
			didWordDragRef.current = false;
			setDragPreview(latestPreview);

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const deltaPixels = moveEvent.clientX - startClientX;
				const deltaSeconds = deltaPixels / pixelsPerSecond;
				const minDuration = 0.01;
				let nextStart = startWord.start;
				let nextEnd = startWord.end;

				if (mode === "move") {
					const duration = startWord.end - startWord.start;
					nextStart = Math.max(0, startWord.start + deltaSeconds);
					nextEnd = nextStart + duration;
				} else if (mode === "left") {
					nextStart = Math.max(
						0,
						Math.min(
							startWord.start + deltaSeconds,
							startWord.end - minDuration,
						),
					);
				} else {
					nextEnd = Math.max(
						startWord.start + minDuration,
						startWord.end + deltaSeconds,
					);
				}

				if (Math.abs(deltaPixels) >= WORD_DRAG_THRESHOLD_PX) {
					hasMoved = true;
					didWordDragRef.current = true;
				}
				latestPreview = { wordIndex, start: nextStart, end: nextEnd };
				dragPreviewRef.current = latestPreview;
				setDragPreview(latestPreview);
			};

			const handleMouseUp = () => {
				window.removeEventListener("mousemove", handleMouseMove);
				window.removeEventListener("mouseup", handleMouseUp);
				const preview = dragPreviewRef.current ?? latestPreview;
				dragPreviewRef.current = null;
				setDragPreview(null);
				if (!hasMoved || !preview) return;
				const nextStart = roundSeconds(preview.start);
				const nextEnd = roundSeconds(
					Math.max(preview.start + 0.01, preview.end),
				);
				updateWord({
					wordIndex,
					update: (current) => ({
						...current,
						start: nextStart,
						end: nextEnd,
					}),
				});
				window.setTimeout(() => {
					didWordDragRef.current = false;
				}, 0);
			};

			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
		},
		[updateWord, words, zoomLevel],
	);

	const editWordText = useCallback(
		({ wordIndex }: { wordIndex: number }) => {
			const word = words[wordIndex];
			if (!word) return;
			const nextText = window.prompt("Edit transcript word", word.text);
			if (nextText === null) return;
			const trimmed = nextText.trim();
			if (!trimmed) return;
			updateWord({
				wordIndex,
				update: (current) => ({ ...current, text: trimmed }),
			});
		},
		[updateWord, words],
	);

	const selectWord = useCallback(
		({ event, wordIndex }: { event: React.MouseEvent; wordIndex: number }) => {
			if (didWordDragRef.current) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			event.stopPropagation();
			const refs = wordElementRefs.get(wordIndex) ?? [];
			if (refs.length === 0) return;

			const isMultiSelect = event.metaKey || event.ctrlKey || event.shiftKey;
			const currentWords = editor.selection.getSelectedTextWords();
			const currentKeys = new Set(currentWords.map(getSelectedTextWordKey));
			const refsAreSelected = refs.every((ref) =>
				currentKeys.has(getSelectedTextWordKey(ref)),
			);
			const nextWords = isMultiSelect
				? refsAreSelected
					? currentWords.filter(
							(word) =>
								!refs.some((ref) =>
									isSameSelectedTextWord({ left: ref, right: word }),
								),
						)
					: dedupeSelectedTextWords([...currentWords, ...refs])
				: refs;

			editor.selection.setSelectedTextWords({ words: nextWords });
			setActivePropertiesTab({ elementType: "text", tabId: "words" });
		},
		[editor, setActivePropertiesTab, wordElementRefs],
	);

	const extendCaptionToIssue = useCallback(
		({ issue }: { issue: WordCoverageIssue }) => {
			const elementStart = mediaTimeToSeconds({
				time: issue.element.startTime,
			});
			const elementEnd =
				elementStart + mediaTimeToSeconds({ time: issue.element.duration });
			const nextStart = issue.side === "left" ? issue.time : elementStart;
			const nextEnd = issue.side === "right" ? issue.time : elementEnd;
			const nextElement = {
				...issue.element,
				startTime: mediaTimeFromSeconds({ seconds: nextStart }),
				duration: mediaTimeFromSeconds({
					seconds: Math.max(0.01, nextEnd - nextStart),
				}),
			};
			editor.timeline.updateElements({
				updates: [
					{
						trackId: issue.track.id,
						elementId: issue.element.id,
						patch: nextElement,
					},
				],
			});
		},
		[editor],
	);

	if (!source || words.length === 0) {
		return null;
	}

	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- timeline timing row is a spatial gesture surface; individual words and tips are native buttons.
		<div
			ref={rowRef}
			className="relative border-b border-red-500/20 bg-red-950/10"
			style={{
				width: `${dynamicTimelineWidth}px`,
				height: `${wordTimingTrackHeight}px`,
			}}
			onMouseDown={onMouseDown}
			onMouseUp={onMouseUp}
			aria-label="Transcript word timing track"
		>
			<div className="absolute inset-y-0 left-0 flex items-center px-2 text-[10px] font-medium uppercase text-red-200/70 pointer-events-none">
				Words
			</div>
			{visibleWordIndexes.map((index) => {
				const word = words[index];
				const preview = getVisibleWordTiming({ word, index, dragPreview });
				const layout = wordLayouts.get(index) ?? {
					lane: 0,
					laneCount: 1,
				};
				const laneHeight = CAPTION_WORD_TIMING_LANE_HEIGHT_PX;
				const refs = wordElementRefs.get(index) ?? [];
				const isSelected = refs.some((ref) =>
					selectedTextWordKeys.has(getSelectedTextWordKey(ref)),
				);
				const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
				const left = preview.start * pixelsPerSecond;
				const width = Math.max(
					WORD_TIMING_MIN_WORD_WIDTH_PX,
					(preview.end - preview.start) * pixelsPerSecond,
				);

				return (
					<ContextMenu key={`${index}-${word.text}`}>
						<ContextMenuTrigger asChild>
							<div
								className={cn(
									"absolute overflow-hidden rounded-sm border border-red-300/40 bg-red-500/20 text-red-50 shadow-sm",
									isSelected &&
										"border-primary bg-primary/30 text-primary-foreground",
									dragPreview?.wordIndex === index &&
										"border-red-100 bg-red-500/35",
								)}
								style={{
									left,
									width,
									top:
										CAPTION_WORD_TIMING_VERTICAL_PADDING_PX / 2 +
										layout.lane * laneHeight,
									height: laneHeight - 2,
								}}
								title={`${word.text} ${word.start.toFixed(2)}s-${word.end.toFixed(2)}s`}
								onDoubleClick={() => editWordText({ wordIndex: index })}
							>
								<button
									type="button"
									className="absolute inset-y-0 left-0 w-2 cursor-w-resize"
									aria-label={`Adjust start of ${word.text}`}
									onMouseDown={(event) =>
										beginWordDrag({ event, wordIndex: index, mode: "left" })
									}
								/>
								<button
									type="button"
									className="absolute inset-y-0 right-0 w-2 cursor-e-resize"
									aria-label={`Adjust end of ${word.text}`}
									onMouseDown={(event) =>
										beginWordDrag({ event, wordIndex: index, mode: "right" })
									}
								/>
								<button
									type="button"
									className="flex size-full cursor-grab items-center justify-center px-2 text-[11px] leading-none"
									onMouseDown={(event) =>
										beginWordDrag({ event, wordIndex: index, mode: "move" })
									}
									onClick={(event) => selectWord({ event, wordIndex: index })}
									aria-label={`Move ${word.text}`}
								>
									<span className="truncate">{word.text}</span>
								</button>
							</div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem
								onSelect={() =>
									insertWord({ wordIndex: index, position: "before" })
								}
							>
								Add word before
							</ContextMenuItem>
							<ContextMenuItem
								onSelect={() =>
									insertWord({ wordIndex: index, position: "after" })
								}
							>
								Add word after
							</ContextMenuItem>
							<ContextMenuItem
								variant="destructive"
								onSelect={() => removeWord({ wordIndex: index })}
							>
								Remove word
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
				);
			})}
			{issues.map((issue) => {
				const left = timelineTimeToPixels({
					time: secondsToMediaTime(issue.time),
					zoomLevel,
				});
				return (
					<button
						key={issue.key}
						type="button"
						className="absolute top-0 bottom-0 z-20 w-2 -translate-x-1/2 bg-red-500 shadow-[0_0_0_1px_rgba(255,255,255,0.55)]"
						style={{ left }}
						title="Caption layer ends before this word timing. Click to extend it."
						aria-label="Extend caption layer to word timing"
						onClick={(event) => {
							event.stopPropagation();
							extendCaptionToIssue({ issue });
						}}
					/>
				);
			})}
		</div>
	);
}

function getWordCoverageIssues({
	words,
	sourceTrack,
	sourceTracks,
}: {
	words: TranscriptionWord[];
	sourceTrack: TextTrack;
	sourceTracks: TextTrack[];
}): WordCoverageIssue[] {
	const issues: WordCoverageIssue[] = [];
	const source = sourceTrack.captionSource;
	if (!source) return issues;

	for (const track of sourceTracks) {
		for (const element of track.elements) {
			const elementStart = mediaTimeToSeconds({ time: element.startTime });
			const elementEnd =
				elementStart + mediaTimeToSeconds({ time: element.duration });
			for (const run of element.wordRuns ?? []) {
				if (!isTimedWordRun(run)) continue;
				const runStart =
					elementStart + mediaTimeToSeconds({ time: run.startTime });
				const runEnd = elementStart + mediaTimeToSeconds({ time: run.endTime });
				const wordIndex = findWordIndexForRun({ words, run, runStart, runEnd });
				if (wordIndex < 0) continue;

				if (runStart < elementStart - 0.001) {
					issues.push({
						key: `${track.id}-${element.id}-${run.id}-left`,
						wordIndex,
						side: "left",
						time: runStart,
						element,
						track,
					});
				}
				if (runEnd > elementEnd + 0.001) {
					issues.push({
						key: `${track.id}-${element.id}-${run.id}-right`,
						wordIndex,
						side: "right",
						time: runEnd,
						element,
						track,
					});
				}
			}
		}
	}

	return issues;
}

function buildWordLayouts({
	words,
	dragPreview,
}: {
	words: TranscriptionWord[];
	dragPreview: { wordIndex: number; start: number; end: number } | null;
}): Map<number, { lane: number; laneCount: number }> {
	const { timedWords, lanes, laneCount } = calculateWordLanes({
		words,
		dragPreview,
	});
	return new Map(
		timedWords.map((word) => [
			word.index,
			{ lane: lanes.get(word.index) ?? 0, laneCount },
		]),
	);
}

function getCaptionWordTimingLaneCount({
	words,
	dragPreview = null,
}: {
	words: TranscriptionWord[];
	dragPreview?: WordDragPreview | null;
}) {
	return calculateWordLanes({ words, dragPreview }).laneCount;
}

function calculateWordLanes({
	words,
	dragPreview,
}: {
	words: TranscriptionWord[];
	dragPreview: WordDragPreview | null;
}) {
	const timedWords = words.map((word, index) => {
		const preview = dragPreview?.wordIndex === index ? dragPreview : word;
		return {
			index,
			start: preview.start,
			end: Math.max(preview.start + 0.01, preview.end),
		};
	});
	const sortedWords = [...timedWords].sort(
		(left, right) => left.start - right.start || left.index - right.index,
	);
	const laneEnds: number[] = [];
	const lanes = new Map<number, number>();

	for (const word of sortedWords) {
		let lane = laneEnds.findIndex((end) => end <= word.start + 0.001);
		if (lane < 0) {
			lane = laneEnds.length;
			laneEnds.push(0);
		}
		lanes.set(word.index, lane);
		laneEnds[lane] = Math.max(laneEnds[lane], word.end);
	}

	const laneCount = Math.max(1, laneEnds.length);
	return { timedWords, lanes, laneCount };
}

function secondsToMediaTime(seconds: number): MediaTime {
	return mediaTimeFromSeconds({ seconds: Math.max(0, seconds) });
}

function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}

function areTranscriptionWordsEqual({
	left,
	right,
}: {
	left: TranscriptionWord;
	right: TranscriptionWord;
}) {
	return (
		left.text === right.text &&
		left.start === right.start &&
		left.end === right.end
	);
}

function getSelectedTextWordKey({
	trackId,
	elementId,
	wordId,
}: SelectedTextWordRef) {
	return `${trackId}:${elementId}:${wordId}`;
}

function isSameSelectedTextWord({
	left,
	right,
}: {
	left: SelectedTextWordRef;
	right: SelectedTextWordRef;
}) {
	return getSelectedTextWordKey(left) === getSelectedTextWordKey(right);
}

function dedupeSelectedTextWords(words: SelectedTextWordRef[]) {
	const seen = new Set<string>();
	return words.filter((word) => {
		const key = getSelectedTextWordKey(word);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
