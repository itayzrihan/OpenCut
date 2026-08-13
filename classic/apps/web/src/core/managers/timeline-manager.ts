import type { EditorCore } from "@/core";
import {
	resolveBackgroundRemovalSettings,
	type BackgroundRemovalSettings,
} from "@/background-removal";
import type { ElementBounds } from "@/preview/element-bounds";
import type { ParamValues } from "@/params";
import type {
	SceneTracks,
	TrackType,
	TimelineTrack,
	TimelineElement,
	RetimeConfig,
	ElementRef,
	VideoElement,
	ParallaxTrackDirection,
} from "@/timeline";
import { clampParallaxSpeed } from "@/parallax-story-teller/parallax-tracks";
import * as wasm from "opencut-wasm";
import { calculateTotalDuration, isExactGlobalTimelineGap } from "@/timeline";
import { TimelineDragSource } from "@/timeline/drag-source";
import { mergeElementOverlay } from "@/timeline/element-overlay";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import {
	lastFrameMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { decodeAudioToFloat32 } from "@/media/audio";
import {
	AUDIO_BASED_AUDIO_FRAME_SECONDS,
	AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS,
	clampAudioMinSilenceSeconds,
	DEEP_AUDIO_FRAME_SECONDS,
	extractCompactAudioFeatures,
	FAST_AUDIO_FRAME_SECONDS,
} from "@/timeline/audio-silence-analysis";
import {
	canElementBeHidden,
	canElementHaveAudio,
} from "@/timeline/element-utils";
import { isElementMuted } from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio } from "@/timeline/audio-separation";
import { getEffectiveRateAt, getSourceTimeAtClipTime } from "@/retime";
import { findCaptionSourceTrack } from "@/subtitles/caption-tracks";
import {
	normalizeTextLayerWordRunIds,
	reconcileTextLayerWordsInCaptionSource,
	syncCaptionSourceWordsFromElements,
	syncTextLayerWordsIntoCaptionSource,
} from "@/subtitles/caption-source-sync";
import type {
	AnimationPath,
	AnimationInterpolation,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import type { ParamValue } from "@/params";
import {
	getElementLocalTime,
	resolveAnimationPathValueAtTime,
} from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { BatchCommand } from "@/commands";
import {
	AddTrackCommand,
	RemoveTrackCommand,
	ReorderTrackCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	InsertElementCommand,
	DeleteElementsCommand,
	DuplicateElementsCommand,
	UpdateElementsCommand,
	ApplyTransitionCommand,
	SplitElementsCommand,
	MergeTextElementsCommand,
	MoveElementCommand,
	TracksSnapshotCommand,
	UpsertKeyframeCommand,
	RemoveKeyframeCommand,
	RetimeKeyframeCommand,
	UpdateScalarKeyframeCurveCommand,
	AddClipEffectCommand,
	DeleteFreeformPathMaskPointsCommand,
	InsertFreeformPathMaskPointCommand,
	RemoveClipEffectCommand,
	UpdateClipEffectParamsCommand,
	ToggleClipEffectCommand,
	ReorderClipEffectsCommand,
	RemoveMaskCommand,
	ToggleMaskInvertedCommand,
	UpsertEffectParamKeyframeCommand,
	RemoveEffectParamKeyframeCommand,
	ToggleSourceAudioSeparationCommand,
	SetBackgroundRemovalCommand,
} from "@/commands/timeline";
import type { InsertElementParams } from "@/commands/timeline/element/insert-element";
import type {
	PlannedElementMove,
	PlannedTrackCreation,
} from "@/timeline/group-move";
import { withNormalizedTrackOrder } from "@/timeline";
import { removeSilenceRangesFromTracks } from "@/timeline/cut-silence";
import { removeTimeRangeFromTracks } from "@/timeline/remove-time-range";
import {
	buildSpeakerFrameBreakoutEdit,
	buildSpeakerTileEdit,
	type SpeakerFrameBreakoutOptions,
	type SpeakerTileOptions,
} from "@/timeline/speaker-tile";
import { buildLoopPatch } from "@/loops";
import {
	buildSpeakerFrameBackgroundSnapshot,
	buildSpeakerFrameMatteSampleTimes,
	buildSpeakerFrameMatteCacheKey,
	buildSpeakerFrameSourceSignature,
	getSpeakerFrameSourceCoverageGap,
	getSpeakerFrameSourceBindings,
	hasUnsupportedSpeakerFramePerspective,
	isSpeakerFrameBreakoutElement,
	readSpeakerFrameBreakoutSettings,
	resolveSpeakerFrameSourceAtTime,
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	clampSpeakerFrameBreakoutFade,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import { backgroundRemovalService } from "@/services/background-removal";
import { VideoCache } from "@/services/video-cache/service";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import { getDisplayTracks } from "@/timeline/track-order";
import {
	buildSpeakerFrameBreakoutFadeTransitions,
	buildSpeakerFrameBreakoutLayerElement,
} from "@/timeline/smart-layer-drop";

const DEEP_SILENCE_ANALYSIS_SETTINGS = {
	minSilenceSeconds: 0.32,
	minSpeechSeconds: 0.08,
	speechPaddingSeconds: 0.1,
	bridgeGapSeconds: 0.14,
	noisePercentile: 0.2,
	minThreshold: 0.0045,
	maxThreshold: 0.08,
	hysteresisRatio: 0.72,
	maxWordSnapSeconds: 0.28,
	minWordDurationSeconds: 0.07,
} as const;

export class TimelineManager {
	private listeners = new Set<() => void>();
	private previewOverlay = new Map<string, Partial<TimelineElement>>();
	private previewRefs = new Map<
		string,
		{ trackId: string; elementId: string }
	>();
	private previewTracks: SceneTracks | null = null;
	public readonly dragSource = new TimelineDragSource();

	constructor(private editor: EditorCore) {}

	addTrack({ type, index }: { type: TrackType; index?: number }): string {
		if (
			type === "parallax" &&
			!this.editor.scenes.getActiveSceneOrNull()?.parallax
		) {
			throw new Error(
				"Parallax tracks are only available inside canvas scenes",
			);
		}
		const command = new AddTrackCommand({ type, index });
		this.editor.command.execute({ command });
		return command.getTrackId();
	}

	updateParallaxTrack({
		trackId,
		direction,
		speedPercent,
	}: {
		trackId: string;
		direction?: ParallaxTrackDirection;
		speedPercent?: number;
	}): void {
		const scene = this.editor.scenes.getActiveSceneOrNull();
		if (!scene?.parallax) return;
		const before = scene.tracks;
		let changed = false;
		const overlay = before.overlay.map((track) => {
			if (track.id !== trackId || track.type !== "parallax") return track;
			changed = true;
			return {
				...track,
				...(direction ? { direction } : {}),
				...(speedPercent !== undefined
					? { speedPercent: clampParallaxSpeed(speedPercent) }
					: {}),
			};
		});
		if (!changed) return;
		const after = { ...before, overlay };
		this.editor.command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
	}

	removeTrack({ trackId }: { trackId: string }): void {
		const command = new RemoveTrackCommand(trackId);
		this.editor.command.execute({ command });
	}

	reorderTrack({
		trackId,
		toIndex,
	}: {
		trackId: string;
		toIndex: number;
	}): void {
		const command = new ReorderTrackCommand({ trackId, toIndex });
		this.editor.command.execute({ command });
	}

	insertElement({ element, placement }: InsertElementParams): string {
		const command = new InsertElementCommand({ element, placement });
		this.editor.command.execute({ command });
		return command.getElementId();
	}

	updateElementTrim({
		elementId,
		trimStart,
		trimEnd,
		startTime,
		duration,
		pushHistory = true,
	}: {
		elementId: string;
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime?: MediaTime;
		duration?: MediaTime;
		pushHistory?: boolean;
	}): void {
		const trackId = this.findTrackIdForElement({ elementId });
		if (!trackId) {
			return;
		}

		const nextUpdates: Partial<TimelineElement> = {
			trimStart,
			trimEnd,
		};
		if (startTime !== undefined) {
			nextUpdates.startTime = startTime;
		}
		if (duration !== undefined) {
			nextUpdates.duration = duration;
		}

		this.updateElements({
			updates: [
				{
					trackId,
					elementId,
					patch: nextUpdates,
				},
			],
			pushHistory,
		});
	}

	updateElementRetime({
		trackId,
		elementId,
		retime,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		retime?: RetimeConfig;
		pushHistory?: boolean;
	}): void {
		this.updateElements({
			updates: [
				{
					trackId,
					elementId,
					patch: {
						retime,
					},
				},
			],
			pushHistory,
		});
	}

	moveElements({
		moves,
		createTracks,
	}: {
		moves: PlannedElementMove[];
		createTracks?: PlannedTrackCreation[];
	}): void {
		if (moves.length === 0) {
			return;
		}

		const command = new MoveElementCommand({
			moves,
			createTracks,
		});
		this.editor.command.execute({ command });
	}

	toggleTrackMute({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackMuteCommand(trackId);
		this.editor.command.execute({ command });
	}

	toggleTrackVisibility({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackVisibilityCommand(trackId);
		this.editor.command.execute({ command });
	}

	splitElements({
		elements,
		splitTime,
		retainSide = "both",
	}: {
		elements: { trackId: string; elementId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}): { trackId: string; elementId: string }[] {
		const command = new SplitElementsCommand({
			elements,
			splitTime,
			retainSide,
		});
		this.editor.command.execute({ command });
		return command.getRightSideElements();
	}

	mergeTextElements({
		elements,
		mode,
	}: {
		elements: { trackId: string; elementId: string }[];
		mode?: "single-line" | "multiline";
	}): void {
		if (elements.length < 2) {
			return;
		}

		const command = new MergeTextElementsCommand({ elements, mode });
		this.editor.command.execute({ command });
	}

	getTotalDuration(): MediaTime {
		const activeScene = this.editor.scenes.getActiveSceneOrNull();
		if (!activeScene) {
			return ZERO_MEDIA_TIME;
		}

		return calculateTotalDuration({ tracks: activeScene.tracks });
	}

	getLastFrameTime(): MediaTime {
		const duration = this.getTotalDuration();
		const fps = this.editor.project.getActive()?.settings.fps;
		if (!fps || duration <= 0) return duration;
		return lastFrameMediaTime({ duration, fps });
	}

	getTrackById({ trackId }: { trackId: string }): TimelineTrack | null {
		const activeScene = this.editor.scenes.getActiveSceneOrNull();
		if (!activeScene) {
			return null;
		}

		return findTrackInSceneTracks({ tracks: activeScene.tracks, trackId });
	}

	getElementsWithTracks({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): Array<{ track: TimelineTrack; element: TimelineElement }> {
		const result: Array<{ track: TimelineTrack; element: TimelineElement }> =
			[];

		for (const { trackId, elementId } of elements) {
			const track = this.getTrackById({ trackId });
			const element = track?.elements.find(
				(trackElement) => trackElement.id === elementId,
			);

			if (track && element) {
				result.push({ track, element });
			}
		}

		return result;
	}

	deleteElements({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const command = new DeleteElementsCommand({ elements });
		this.editor.command.execute({ command });
	}

	createSpeakerTile({
		trackId,
		elementId,
		options,
	}: {
		trackId: string;
		elementId: string;
		options: SpeakerTileOptions;
	}): ElementRef | null {
		const before = this.editor.scenes.getActiveScene().tracks;
		const result = buildSpeakerTileEdit({
			tracks: before,
			trackId,
			elementId,
			options,
		});
		if (!result) return null;
		this.editor.command.execute({
			command: new TracksSnapshotCommand({
				before,
				after: result.tracks,
			}),
		});
		return result.target;
	}

	createSpeakerFrameBreakout({
		trackId,
		elementId,
		options,
	}: {
		trackId: string;
		elementId: string;
		options: Pick<
			SpeakerFrameBreakoutOptions,
			| "positionX"
			| "positionY"
			| "scaleX"
			| "scaleY"
			| "cropTop"
			| "cornerRadius"
			| "backgroundPresetId"
			| "startTime"
			| "duration"
			| "name"
		>;
	}): ElementRef | null {
		const tracks = this.editor.scenes.getActiveScene().tracks;
		const targetTrack = findTrackInSceneTracks({ tracks, trackId });
		const source = targetTrack?.elements.find(
			(element) => element.id === elementId,
		);
		if (!targetTrack || !source || source.type !== "video") return null;

		const startTime = options.startTime ?? source.startTime;
		const duration =
			options.duration ??
			roundMediaTime({
				time: source.startTime + source.duration - startTime,
			});
		if (
			startTime < source.startTime ||
			startTime >= source.startTime + source.duration ||
			duration <= 0 ||
			startTime + duration > calculateTotalDuration({ tracks })
		) {
			return null;
		}
		const background = BACKGROUND_PRESETS.find(
			(preset) => preset.id === options.backgroundPresetId,
		);
		if (!background) return null;

		const element = buildSpeakerFrameBreakoutLayerElement({
			startTime,
			duration,
			name: options.name ?? "Speaker Frame Breakout",
			params: {
				...SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
				...buildSpeakerFrameBackgroundSnapshot({
					presetId: background.id,
					params: background.params,
				}),
				positionX: options.positionX,
				positionY: options.positionY,
				scaleX: options.scaleX,
				scaleY: options.scaleY,
				cropTop: options.cropTop,
				cornerRadius: options.cornerRadius,
			},
		});
		const targetIndex = getDisplayTracks({ tracks }).findIndex(
			(track) => track.id === trackId,
		);
		if (targetIndex < 0) return null;
		const addTrackCommand = new AddTrackCommand({
			type: "effect",
			index: targetIndex,
		});
		const insertElementCommand = new InsertElementCommand({
			element,
			placement: {
				mode: "explicit",
				trackId: addTrackCommand.getTrackId(),
			},
		});
		this.editor.command.execute({
			command: new BatchCommand([addTrackCommand, insertElementCommand]),
		});
		return {
			trackId: addTrackCommand.getTrackId(),
			elementId: insertElementCommand.getElementId(),
		};
	}

	createMaterializedSpeakerFrameBreakout({
		trackId,
		elementId,
		options,
	}: {
		trackId: string;
		elementId: string;
		options: SpeakerFrameBreakoutOptions;
	}): {
		source: ElementRef;
		foreground: ElementRef;
		base: ElementRef;
		background: ElementRef;
	} | null {
		const before = this.editor.scenes.getActiveScene().tracks;
		const result = buildSpeakerFrameBreakoutEdit({
			tracks: before,
			trackId,
			elementId,
			options,
		});
		if (!result) return null;
		this.editor.command.execute({
			command: new TracksSnapshotCommand({
				before,
				after: result.tracks,
			}),
		});
		return {
			source: result.source,
			foreground: result.foreground,
			base: result.base,
			background: result.background,
		};
	}

	async applySpeakerFrameBreakout({
		trackId,
		elementId,
		params,
		signal,
		onProgress,
	}: {
		trackId: string;
		elementId: string;
		params: ParamValues;
		signal?: AbortSignal;
		onProgress?: (progress: {
			completedFrames: number;
			totalFrames: number;
		}) => void;
	}): Promise<{
		cacheKey: string;
		sourceSignature: string;
		preparedFrames: number;
		backend: string;
	}> {
		throwIfSpeakerFrameApplyAborted(signal);
		const scene = this.editor.scenes.getActiveScene();
		const track = findTrackInSceneTracks({ tracks: scene.tracks, trackId });
		const storedLayer = track?.elements.find(
			(element) => element.id === elementId,
		);
		if (
			!track ||
			track.type !== "effect" ||
			!storedLayer ||
			storedLayer.type !== "effect" ||
			!isSpeakerFrameBreakoutElement(storedLayer)
		) {
			throw new Error("Speaker Frame Breakout layer was not found");
		}
		const initialEditorStateRevision = this.editor.command.getStateRevision();
		const initialLayerSnapshot = JSON.stringify(storedLayer);
		const layer = { ...storedLayer, params };
		const settings = readSpeakerFrameBreakoutSettings({ params });
		const mediaAssets = this.editor.media.getAssets();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: scene.tracks,
			smartTrackId: trackId,
			layer,
		});
		if (bindings.length === 0) {
			throw new Error("Place this smart layer directly above a video first");
		}
		const sourceSignature = buildSpeakerFrameSourceSignature({
			layer,
			bindings,
			mediaAssets,
			settings,
		});
		const cacheKey = buildSpeakerFrameMatteCacheKey({
			layerId: layer.id,
			signature: sourceSignature,
		});
		const resolvedMatte = resolveBackgroundRemovalSettings({
			settings: settings.matte,
		});

		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		const coverageGap = getSpeakerFrameSourceCoverageGap({
			bindings,
			layer,
		});
		if (coverageGap) {
			throw new Error(
				`Every frame of this smart layer must overlap a visible video (gap ${mediaTimeToSeconds(
					{
						time: coverageGap.startTime,
					},
				).toFixed(3)}s-${mediaTimeToSeconds({
					time: coverageGap.endTime,
				}).toFixed(3)}s)`,
			);
		}
		const sampleTimes = buildSpeakerFrameMatteSampleTimes({
			bindings,
			layer,
			previewFps: resolvedMatte.previewFps,
		});
		const plannedFrames = new Map<
			string,
			{
				mediaId: string;
				file?: File;
				url?: string;
				sourceTime: number;
				temporalSequenceKey: string;
			}
		>();
		let previousBindingKey = "";
		let temporalSequenceOrdinal = 0;
		const plannedSourceElements = new Map<string, VideoElement>();
		for (const timelineTime of sampleTimes) {
			const sourceBinding = resolveSpeakerFrameSourceAtTime({
				bindings,
				time: timelineTime,
			});
			if (!sourceBinding) {
				throw new Error(
					"Every prepared matte sample must resolve to a visible video",
				);
			}
			const source = sourceBinding.element;
			plannedSourceElements.set(source.id, source);
			const bindingKey = `${sourceBinding.trackId}:${source.id}`;
			if (bindingKey !== previousBindingKey) {
				temporalSequenceOrdinal += 1;
				previousBindingKey = bindingKey;
			}
			const asset = mediaById.get(source.mediaId);
			if (!asset || asset.type !== "video" || (!asset.url && !asset.file)) {
				throw new Error("A source video under this smart layer is unavailable");
			}
			const clipTime = timelineTime - source.startTime;
			const sourceTimeTicks =
				source.trimStart +
				getSourceTimeAtClipTime({
					clipTime,
					retime: source.retime,
				});
			const sourceTime = mediaTimeToSeconds({
				time: roundMediaTime({ time: sourceTimeTicks }),
			});
			const inferenceKey = backgroundRemovalService.getPreparedInferenceKey({
				mediaId: asset.id,
				sourceTime,
				settings: resolvedMatte,
			});
			if (!plannedFrames.has(inferenceKey)) {
				plannedFrames.set(inferenceKey, {
					mediaId: asset.id,
					file: asset.file,
					url: asset.url,
					sourceTime,
					temporalSequenceKey: `${cacheKey}:${bindingKey}:${temporalSequenceOrdinal}`,
				});
			}
		}
		const expectedInferenceKeys = [...plannedFrames.keys()].sort();
		if (expectedInferenceKeys.length === 0) {
			throw new Error("No video frames were available under this layer");
		}
		for (const source of plannedSourceElements.values()) {
			if ((source.masks?.length ?? 0) > 0) {
				throw new Error(
					`"${source.name}" has a custom mask. Remove it or use an unmasked duplicate before applying Speaker Frame Breakout.`,
				);
			}
			if (source.backgroundRemoval?.enabled) {
				throw new Error(
					`"${source.name}" already removes its background. Use an unprocessed duplicate before applying Speaker Frame Breakout.`,
				);
			}
			if (hasUnsupportedSpeakerFramePerspective({ source })) {
				throw new Error(
					`"${source.name}" uses perspective. Reset its perspective before applying Speaker Frame Breakout.`,
				);
			}
		}
		const preparedApply = await waitForSpeakerFrameApplyAbort({
			promise: backgroundRemovalService.preparePreparedGroupApply({
				groupKey: cacheKey,
				expectedInferenceKeys,
				temporalSmoothing: resolvedMatte.temporalSmoothing,
			}),
			signal,
		});
		throwIfSpeakerFrameApplyAborted(signal);
		let preparedFrames = backgroundRemovalService.getPreparedGroupFrameCount({
			groupKey: cacheKey,
		});
		if (preparedApply.reusable) {
			onProgress?.({
				completedFrames: expectedInferenceKeys.length,
				totalFrames: expectedInferenceKeys.length,
			});
		} else {
			await waitForSpeakerFrameApplyAbort({
				promise: backgroundRemovalService.preload(),
				signal,
			});
			throwIfSpeakerFrameApplyAborted(signal);
			const applyVideoCache = new VideoCache();
			try {
				let completedFrames = 0;
				for (const plannedFrame of plannedFrames.values()) {
					throwIfSpeakerFrameApplyAborted(signal);
					const frame = await applyVideoCache.getFrameAt({
						mediaId: plannedFrame.mediaId,
						file: plannedFrame.file,
						url: plannedFrame.url,
						time: plannedFrame.sourceTime,
					});
					if (!frame) {
						throw new Error(
							"One or more source video frames were unavailable. Reapply after the media is ready.",
						);
					}
					await backgroundRemovalService.prepareMaskFrame({
						groupKey: cacheKey,
						source: frame.canvas,
						mediaId: plannedFrame.mediaId,
						sourceTime: plannedFrame.sourceTime,
						settings: resolvedMatte,
						signal,
						temporalSequenceKey: plannedFrame.temporalSequenceKey,
					});
					completedFrames += 1;
					onProgress?.({
						completedFrames,
						totalFrames: expectedInferenceKeys.length,
					});
				}
			} finally {
				applyVideoCache.clearAll();
			}
			backgroundRemovalService.markPreparedGroupComplete({
				groupKey: cacheKey,
				expectedInferenceKeys,
			});
			preparedFrames = backgroundRemovalService.getPreparedGroupFrameCount({
				groupKey: cacheKey,
			});
		}
		await waitForSpeakerFrameApplyAbort({
			promise: backgroundRemovalService.flushPreparedMaskPersistence({
				groupKey: cacheKey,
			}),
			signal,
		});
		if (preparedFrames === 0) {
			throw new Error("No video frames were available under this layer");
		}
		throwIfSpeakerFrameApplyAborted(signal);

		const freshScene = this.editor.scenes.getActiveScene();
		const freshTrack = findTrackInSceneTracks({
			tracks: freshScene.tracks,
			trackId,
		});
		const freshElement = freshTrack?.elements.find(
			(element) => element.id === elementId,
		);
		if (
			!freshElement ||
			freshElement.type !== "effect" ||
			JSON.stringify(freshElement) !== initialLayerSnapshot
		) {
			throw new Error(
				"The smart layer changed while Apply was running. Its newer settings were preserved; apply it again.",
			);
		}
		const freshBindings = getSpeakerFrameSourceBindings({
			tracks: freshScene.tracks,
			smartTrackId: trackId,
			layer: freshElement,
		});
		const freshSignature = buildSpeakerFrameSourceSignature({
			layer: freshElement,
			bindings: freshBindings,
			mediaAssets: this.editor.media.getAssets(),
			settings,
		});
		if (freshSignature !== sourceSignature) {
			throw new Error(
				"The source video changed while Apply was running. Apply it again.",
			);
		}
		if (this.editor.command.getStateRevision() !== initialEditorStateRevision) {
			throw new Error(
				"The editor changed while Apply was running. The newer edit and Undo/Redo history were preserved; apply it again.",
			);
		}
		const status = backgroundRemovalService.getStatus();
		const backend = status.state === "ready" ? status.backend : "unknown";
		const fade = clampSpeakerFrameBreakoutFade({
			duration: freshElement.duration,
			fadeInDuration: settings.fadeInDuration,
			fadeOutDuration: settings.fadeOutDuration,
		});
		this.updateElements({
			updates: [
				{
					trackId,
					elementId,
					patch: {
						params: {
							...params,
							fadeInDuration: fade.fadeInDuration,
							fadeOutDuration: fade.fadeOutDuration,
							matteApplied: true,
							matteCacheKey: cacheKey,
							sourceSignature,
							appliedStartTime: layer.startTime,
							appliedDuration: layer.duration,
							appliedBackend: backend,
						},
						transitions: buildSpeakerFrameBreakoutFadeTransitions({
							element: freshElement,
							fadeInDuration: fade.fadeInDuration,
							fadeOutDuration: fade.fadeOutDuration,
						}),
					},
				},
			],
		});
		return {
			cacheKey,
			sourceSignature,
			preparedFrames,
			backend,
		};
	}

	closeGap({
		startTime,
		endTime,
	}: {
		startTime: MediaTime;
		endTime: MediaTime;
	}): void {
		const before = this.editor.scenes.getActiveScene().tracks;
		if (!isExactGlobalTimelineGap({ tracks: before, startTime, endTime })) {
			return;
		}
		const after = removeTimeRangeFromTracks({
			tracks: before,
			startTime,
			endTime,
		});
		this.editor.command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
	}

	async removeAllSilence({
		mode = "audio",
		minSilenceSeconds,
	}: {
		mode?: "audio" | "fast" | "deep";
		minSilenceSeconds?: number;
	} = {}): Promise<void> {
		const scene = this.editor.scenes.getActiveScene();
		const before = scene.tracks;
		const project = this.editor.project.getActive();
		const mediaAssets = this.editor.media.getAssets();
		const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		const selectedVideos = this.getElementsWithTracks({
			elements: this.editor.selection.getSelectedElements(),
		})
			.filter(({ element }) => element.type === "video")
			.sort((left, right) => left.element.startTime - right.element.startTime);
		if (selectedVideos.length === 0) return;

		const ranges: Array<{ startTime: MediaTime; endTime: MediaTime }> = [];
		const captionSourceTrack = findCaptionSourceTrack({ tracks: before });
		const captionSource = captionSourceTrack?.captionSource;
		const usesAdaptiveAudioAnalysis = mode === "audio" || mode === "deep";
		const audioSettings =
			mode === "audio"
				? {
						...AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS,
						minSilenceSeconds: clampAudioMinSilenceSeconds(
							minSilenceSeconds ??
								AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS.minSilenceSeconds,
						),
					}
				: AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS;
		const refinedCaptionWords =
			usesAdaptiveAudioAnalysis && captionSource
				? captionSource.words.map((word) => ({ ...word }))
				: undefined;
		const assignedCaptionWordIndexes = new Set<number>();
		const decodedByMediaId = new Map<
			string,
			Promise<Awaited<ReturnType<typeof decodeAudioToFloat32>> | null>
		>();
		let analyzedClipCount = 0;

		for (const { track, element } of selectedVideos) {
			if (element.type !== "video") continue;
			const asset = mediaById.get(element.mediaId);
			if (
				(!asset?.file && !asset?.url) ||
				track.type !== "video" ||
				track.muted ||
				isElementMuted({ element }) ||
				!doesElementHaveEnabledAudio({ element, mediaAsset: asset })
			) {
				continue;
			}

			let decodedPromise = decodedByMediaId.get(asset.id);
			if (!decodedPromise) {
				decodedPromise = decodeAudioToFloat32({
					audioBlob: asset.file,
					url: asset.url,
				}).catch((error) => {
					console.warn(`Failed to decode audio for ${asset.name}:`, error);
					return null;
				});
				decodedByMediaId.set(asset.id, decodedPromise);
			}
			const decoded = await decodedPromise;
			if (!decoded) continue;

			const clipDuration = mediaTimeToSeconds({ time: element.duration });
			const playbackRate = getEffectiveRateAt({ retime: element.retime });
			const sourceStart = mediaTimeToSeconds({ time: element.trimStart });
			const sourceEnd =
				sourceStart +
				getSourceTimeAtClipTime({
					clipTime: clipDuration,
					retime: element.retime,
				});
			const frames = await extractCompactAudioFeatures({
				samples: decoded.samples,
				sampleRate: decoded.sampleRate,
				sourceStartSeconds: sourceStart,
				sourceEndSeconds: sourceEnd,
				playbackRate,
				frameDurationSeconds:
					mode === "audio"
						? AUDIO_BASED_AUDIO_FRAME_SECONDS
						: mode === "deep"
							? DEEP_AUDIO_FRAME_SECONDS
							: FAST_AUDIO_FRAME_SECONDS,
			});
			if (frames.length === 0) continue;
			analyzedClipCount += 1;

			const localRanges = usesAdaptiveAudioAnalysis
				? (() => {
						const clipStart = mediaTimeToSeconds({ time: element.startTime });
						const transcriptWords = (refinedCaptionWords ?? []).flatMap(
							(word, wordIndex) => {
								if (
									word.source?.type === "text-layer" ||
									assignedCaptionWordIndexes.has(wordIndex)
								) {
									return [];
								}
								const midpoint = (word.start + word.end) / 2;
								if (
									midpoint < clipStart ||
									midpoint >= clipStart + clipDuration
								) {
									return [];
								}
								return [
									{
										wordIndex,
										start: Math.max(0, word.start - clipStart),
										end: Math.min(clipDuration, word.end - clipStart),
									},
								];
							},
						);
						const result = wasm.analyzeAudioSilence({
							frames,
							durationSeconds: clipDuration,
							transcriptWords,
							settings:
								mode === "audio"
									? audioSettings
									: DEEP_SILENCE_ANALYSIS_SETTINGS,
						});
						for (const refinedWord of result.refinedWords) {
							const word = refinedCaptionWords?.[refinedWord.wordIndex];
							if (!word || word.source?.type === "text-layer") continue;
							word.start = clipStart + refinedWord.start;
							word.end = clipStart + refinedWord.end;
							assignedCaptionWordIndexes.add(refinedWord.wordIndex);
						}
						return result.cutRanges;
					})()
				: wasm.detectFastAudioSilence({
						frames,
						durationSeconds: clipDuration,
					});

			for (const range of localRanges) {
				const start = Math.max(0, Math.min(clipDuration, range.start));
				const end = Math.max(start, Math.min(clipDuration, range.end));
				if (end <= start) continue;
				ranges.push({
					startTime: mediaTime({
						ticks: element.startTime + mediaTimeFromSeconds({ seconds: start }),
					}),
					endTime: mediaTime({
						ticks: element.startTime + mediaTimeFromSeconds({ seconds: end }),
					}),
				});
			}
		}

		if (analyzedClipCount === 0) {
			throw new Error(
				"The selected video clips do not have enabled, decodable audio to analyze.",
			);
		}
		const activeScene = this.editor.scenes.getActiveSceneOrNull();
		if (activeScene?.id !== scene.id || activeScene.tracks !== before) {
			throw new Error(
				"The timeline changed while audio was being analyzed. No silence cuts were applied.",
			);
		}

		const captionWordsChanged =
			refinedCaptionWords !== undefined &&
			captionSource !== undefined &&
			refinedCaptionWords.some((word, index) => {
				const original = captionSource.words[index];
				return (
					original !== undefined &&
					(word.start !== original.start || word.end !== original.end)
				);
			});
		if (ranges.length === 0 && !captionWordsChanged) return;
		const after = removeSilenceRangesFromTracks({
			tracks: before,
			ranges,
			cutElementIds: selectedVideos.map(({ element }) => element.id),
			captionCanvasSize: project.settings.canvasSize,
			captionWordsOverride: captionWordsChanged
				? refinedCaptionWords
				: undefined,
			captionWordsOverrideSourceId: captionWordsChanged
				? captionSource?.sourceId
				: undefined,
		});
		if (after === before) return;
		this.editor.command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
	}

	toggleSourceAudioSeparation({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): void {
		const command = new ToggleSourceAudioSeparationCommand({
			trackId,
			elementId,
		});
		this.editor.command.execute({ command });
	}

	updateElements({
		updates,
		pushHistory = true,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
		}>;
		pushHistory?: boolean;
	}): void {
		if (updates.length === 0) {
			return;
		}

		const command = new UpdateElementsCommand({
			updates,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	applyTransitions({
		applications,
	}: {
		applications: ConstructorParameters<typeof ApplyTransitionCommand>[0];
	}): void {
		if (applications.length === 0) {
			return;
		}
		this.editor.command.execute({
			command: new ApplyTransitionCommand(applications),
		});
	}

	applyLoops({
		applications,
	}: {
		applications: Array<{
			trackId: string;
			elementId: string;
			loopId: string;
		}>;
	}): void {
		const updates = applications.flatMap((application) => {
			const entry = this.getElementsWithTracks({
				elements: [application],
			})[0];
			if (
				!entry ||
				(entry.element.type !== "video" && entry.element.type !== "image")
			) {
				return [];
			}
			return [
				{
					trackId: application.trackId,
					elementId: application.elementId,
					patch: buildLoopPatch({
						element: entry.element,
						loopId: application.loopId,
					}),
				},
			];
		});
		this.updateElements({ updates });
	}

	addClipEffect({
		trackId,
		elementId,
		effectType,
		params,
	}: {
		trackId: string;
		elementId: string;
		effectType: string;
		params?: Partial<ParamValues>;
	}): string {
		const command = new AddClipEffectCommand({
			trackId,
			elementId,
			effectType,
			params,
		});
		this.editor.command.execute({ command });
		return command.getEffectId() ?? "";
	}

	removeClipEffect({
		trackId,
		elementId,
		effectId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
	}): void {
		const command = new RemoveClipEffectCommand({
			trackId,
			elementId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	removeMask({
		trackId,
		elementId,
		maskId,
	}: {
		trackId: string;
		elementId: string;
		maskId: string;
	}): void {
		const command = new RemoveMaskCommand({
			trackId,
			elementId,
			maskId,
		});
		this.editor.command.execute({ command });
	}

	deleteFreeformPathMaskPoints({
		trackId,
		elementId,
		maskId,
		pointIds,
	}: {
		trackId: string;
		elementId: string;
		maskId: string;
		pointIds: string[];
	}): void {
		if (pointIds.length === 0) {
			return;
		}
		const command = new DeleteFreeformPathMaskPointsCommand({
			trackId,
			elementId,
			maskId,
			pointIds,
		});
		this.editor.command.execute({ command });
	}

	insertFreeformPathMaskPoint({
		trackId,
		elementId,
		maskId,
		segmentIndex,
		canvasPoint,
		bounds,
	}: {
		trackId: string;
		elementId: string;
		maskId: string;
		segmentIndex: number;
		canvasPoint: { x: number; y: number };
		bounds: ElementBounds;
	}): void {
		const command = new InsertFreeformPathMaskPointCommand({
			trackId,
			elementId,
			maskId,
			segmentIndex,
			canvasPoint,
			bounds,
		});
		this.editor.command.execute({ command });
	}

	updateClipEffectParams({
		trackId,
		elementId,
		effectId,
		params,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		params: Partial<ParamValues>;
		pushHistory?: boolean;
	}): void {
		const command = new UpdateClipEffectParamsCommand({
			trackId,
			elementId,
			effectId,
			params,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	toggleClipEffect({
		trackId,
		elementId,
		effectId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
	}): void {
		const command = new ToggleClipEffectCommand({
			trackId,
			elementId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	toggleMaskInverted({
		trackId,
		elementId,
		maskId,
	}: {
		trackId: string;
		elementId: string;
		maskId: string;
	}): void {
		const command = new ToggleMaskInvertedCommand({
			trackId,
			elementId,
			maskId,
		});
		this.editor.command.execute({ command });
	}

	reorderClipEffects({
		trackId,
		elementId,
		fromIndex,
		toIndex,
	}: {
		trackId: string;
		elementId: string;
		fromIndex: number;
		toIndex: number;
	}): void {
		const command = new ReorderClipEffectsCommand({
			trackId,
			elementId,
			fromIndex,
			toIndex,
		});
		this.editor.command.execute({ command });
	}

	upsertKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPath;
			time: MediaTime;
			value: ParamValue;
			interpolation?: AnimationInterpolation;
			keyframeId?: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({
				trackId,
				elementId,
				propertyPath,
				time,
				value,
				interpolation,
				keyframeId,
			}) =>
				new UpsertKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					time,
					value,
					interpolation,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	removeKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPath;
			keyframeId: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		// Pre-sample values at playhead for each (element, property) pair.
		// This preserves "what you see is what you get" when all keyframes are deleted.
		const playheadTime = this.editor.playback.getCurrentTime();
		const valueAtPlayheadMap = new Map<string, ParamValue | null>();

		for (const { trackId, elementId, propertyPath } of keyframes) {
			const key = `${elementId}:${propertyPath}`;
			if (valueAtPlayheadMap.has(key)) {
				continue;
			}

			const element = this.getElementByRef({ trackId, elementId });
			if (!element) {
				valueAtPlayheadMap.set(key, null);
				continue;
			}

			const localTime = getElementLocalTime({
				timelineTime: playheadTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			});

			const target = resolveAnimationTarget({ element, path: propertyPath });
			const baseValue = target?.getBaseValue() ?? null;
			if (baseValue === null) {
				valueAtPlayheadMap.set(key, null);
				continue;
			}

			const value = resolveAnimationPathValueAtTime({
				animations: element.animations,
				propertyPath,
				localTime,
				fallbackValue: baseValue,
			});
			valueAtPlayheadMap.set(key, value);
		}

		const commands = keyframes.map(
			({ trackId, elementId, propertyPath, keyframeId }) =>
				new RemoveKeyframeCommand({
					trackId,
					elementId,
					propertyPath,
					keyframeId,
					valueAtPlayhead:
						valueAtPlayheadMap.get(`${elementId}:${propertyPath}`) ?? null,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	retimeKeyframe({
		trackId,
		elementId,
		propertyPath,
		keyframeId,
		time,
	}: {
		trackId: string;
		elementId: string;
		propertyPath: AnimationPath;
		keyframeId: string;
		time: MediaTime;
	}): void {
		const command = new RetimeKeyframeCommand({
			trackId,
			elementId,
			propertyPath,
			keyframeId,
			nextTime: time,
		});
		this.editor.command.execute({ command });
	}

	updateKeyframeCurves({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			elementId: string;
			propertyPath: AnimationPath;
			componentKey: string;
			keyframeId: string;
			patch: ScalarCurveKeyframePatch;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({ trackId, elementId, propertyPath, componentKey, keyframeId, patch }) =>
				new UpdateScalarKeyframeCurveCommand({
					trackId,
					elementId,
					propertyPath,
					componentKey,
					keyframeId,
					patch,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	upsertEffectParamKeyframe({
		trackId,
		elementId,
		effectId,
		paramKey,
		time,
		value,
		interpolation,
		keyframeId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
		time: MediaTime;
		value: number;
		interpolation?: "linear" | "hold";
		keyframeId?: string;
	}): void {
		const command = new UpsertEffectParamKeyframeCommand({
			trackId,
			elementId,
			effectId,
			paramKey,
			time,
			value,
			interpolation,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	removeEffectParamKeyframe({
		trackId,
		elementId,
		effectId,
		paramKey,
		keyframeId,
	}: {
		trackId: string;
		elementId: string;
		effectId: string;
		paramKey: string;
		keyframeId: string;
	}): void {
		const command = new RemoveEffectParamKeyframeCommand({
			trackId,
			elementId,
			effectId,
			paramKey,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	isPreviewActive(): boolean {
		return this.previewOverlay.size > 0;
	}

	previewElements({
		updates,
	}: {
		updates: readonly {
			trackId: string;
			elementId: string;
			updates: Partial<TimelineElement>;
		}[];
	}): void {
		let changedOverlayCount = 0;
		for (const { trackId, elementId, updates: elementUpdates } of updates) {
			const existingOverlay = this.previewOverlay.get(elementId);
			const changed = Object.entries(elementUpdates).some(([key, value]) => {
				const existingValue = Object.entries(existingOverlay ?? {}).find(
					([existingKey]) => existingKey === key,
				)?.[1];
				return !Object.is(existingValue, value);
			});
			if (changed) {
				changedOverlayCount += 1;
				const mergedOverlay = mergeElementOverlay({
					base: existingOverlay,
					overlay: elementUpdates,
				});
				this.previewOverlay.set(elementId, mergedOverlay);
				this.previewRefs.set(elementId, {
					trackId,
					elementId,
				});
			}
		}
		const committedTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!committedTracks) {
			return;
		}
		if (changedOverlayCount === 0) {
			return;
		}
		this.previewTracks = this.applyPreviewOverlay(committedTracks);
		this.notify();
	}

	commitPreview(): void {
		if (this.previewOverlay.size === 0) return;
		const committedTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!committedTracks) {
			return;
		}
		let afterTracks =
			this.previewTracks ?? this.applyPreviewOverlay(committedTracks);
		const updatedRefs = [...this.previewRefs.values()].filter(
			(ref) => ref.trackId.length > 0,
		);
		afterTracks = syncCaptionSourceWordsFromElements({
			tracks: afterTracks,
			previousTracks: committedTracks,
			updates: updatedRefs,
		});
		afterTracks = syncTextLayerWordsIntoCaptionSource({
			tracks: afterTracks,
			elements: updatedRefs,
		});
		const command = new TracksSnapshotCommand({
			before: committedTracks,
			after: afterTracks,
		});
		const beforeSnapshot = this.editor.command.captureProjectSnapshot();
		this.previewOverlay.clear();
		this.previewRefs.clear();
		this.previewTracks = null;
		this.updateTracks(afterTracks);
		this.editor.command.push({ command, beforeSnapshot });
	}

	discardPreview(): void {
		if (this.previewOverlay.size === 0) return;
		this.previewOverlay.clear();
		this.previewRefs.clear();
		this.previewTracks = null;
		this.notify();
	}

	private applyPreviewOverlay(tracks: SceneTracks): SceneTracks {
		if (this.previewOverlay.size === 0) return tracks;

		const applyTrackOverlay = <TTrack extends TimelineTrack>(
			track: TTrack,
		): TTrack => {
			const hasOverlay = track.elements.some((element) =>
				this.previewOverlay.has(element.id),
			);
			if (!hasOverlay) {
				return track;
			}

			const nextElements = track.elements.map((element) => {
				const overlay = this.previewOverlay.get(element.id);
				return overlay
					? applyElementUpdate({
							element,
							patch: overlay,
							context: { tracks, trackId: track.id },
						})
					: element;
			});

			return { ...track, elements: nextElements } as TTrack;
		};

		return {
			...tracks,
			overlay: tracks.overlay.map((track) => applyTrackOverlay(track)),
			main: applyTrackOverlay(tracks.main),
			audio: tracks.audio.map((track) => applyTrackOverlay(track)),
		};
	}

	duplicateElements({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): { trackId: string; elementId: string }[] {
		const command = new DuplicateElementsCommand({ elements });
		this.editor.command.execute({ command });
		return command.getDuplicatedElements();
	}

	setBackgroundRemoval({
		trackId,
		elementId,
		settings,
		duplicate = false,
	}: {
		trackId: string;
		elementId: string;
		settings: BackgroundRemovalSettings;
		duplicate?: boolean;
	}): { trackId: string; elementId: string } | null {
		const command = new SetBackgroundRemovalCommand({
			trackId,
			elementId,
			settings,
			duplicate,
		});
		this.editor.command.execute({ command });
		return command.getTarget();
	}

	toggleElementsVisibility({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const shouldHide = elements.some(({ trackId, elementId }) => {
			const element = this.getElementByRef({ trackId, elementId });
			return element && canElementBeHidden(element) && !element.hidden;
		});

		const nextUpdates = elements.flatMap(({ trackId, elementId }) => {
			const element = this.getElementByRef({ trackId, elementId });
			if (!element || !canElementBeHidden(element)) {
				return [];
			}

			return [
				{
					trackId,
					elementId,
					patch: { hidden: shouldHide },
				},
			];
		});

		this.updateElements({ updates: nextUpdates });
	}

	toggleElementsMuted({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}): void {
		const shouldMute = elements.some(({ trackId, elementId }) => {
			const element = this.getElementByRef({ trackId, elementId });
			return (
				element && canElementHaveAudio(element) && !isElementMuted({ element })
			);
		});

		const nextUpdates = elements.flatMap(({ trackId, elementId }) => {
			const element = this.getElementByRef({ trackId, elementId });
			if (!element || !canElementHaveAudio(element)) {
				return [];
			}

			return [
				{
					trackId,
					elementId,
					patch: { params: { muted: shouldMute } },
				},
			];
		});

		this.updateElements({ updates: nextUpdates });
	}

	getPreviewTracks(): SceneTracks | null {
		return (
			this.previewTracks ??
			this.editor.scenes.getActiveSceneOrNull()?.tracks ??
			null
		);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private getElementByRef({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): TimelineElement | undefined {
		return this.getTrackById({ trackId })?.elements.find(
			(element) => element.id === elementId,
		);
	}

	private findTrackIdForElement({
		elementId,
	}: {
		elementId: string;
	}): string | null {
		const activeScene = this.editor.scenes.getActiveSceneOrNull();
		if (!activeScene) {
			return null;
		}

		if (
			activeScene.tracks.main.elements.some(
				(element) => element.id === elementId,
			)
		) {
			return activeScene.tracks.main.id;
		}

		for (const track of activeScene.tracks.overlay) {
			if (track.elements.some((element) => element.id === elementId)) {
				return track.id;
			}
		}

		for (const track of activeScene.tracks.audio) {
			if (track.elements.some((element) => element.id === elementId)) {
				return track.id;
			}
		}

		return null;
	}

	updateTracks(newTracks: SceneTracks): void {
		this.previewOverlay.clear();
		this.previewRefs.clear();
		this.previewTracks = null;
		const previousTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		const normalizedTracks = normalizeTextLayerWordRunIds({
			tracks: newTracks,
		});
		const sourceElementRefs = normalizedTracks.overlay.flatMap((track) => {
			if (track.type !== "text" || !track.captionSource) return [];
			return track.elements.map((element) => ({
				trackId: track.id,
				elementId: element.id,
			}));
		});
		const sourceSyncedTracks = syncCaptionSourceWordsFromElements({
			tracks: normalizedTracks,
			previousTracks,
			updates: sourceElementRefs,
		});
		const reconciledTracks = reconcileTextLayerWordsInCaptionSource({
			tracks: sourceSyncedTracks,
		});
		this.editor.scenes.updateSceneTracks({
			tracks: withNormalizedTrackOrder({ tracks: reconciledTracks }),
		});
		this.notify();
	}
}

function throwIfSpeakerFrameApplyAborted(signal: AbortSignal | undefined) {
	if (!signal?.aborted) return;
	throw new DOMException(
		"Speaker Frame Breakout Apply was cancelled",
		"AbortError",
	);
}

function waitForSpeakerFrameApplyAbort<T>({
	promise,
	signal,
}: {
	promise: Promise<T>;
	signal: AbortSignal | undefined;
}): Promise<T> {
	if (!signal) return promise;
	throwIfSpeakerFrameApplyAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				new DOMException(
					"Speaker Frame Breakout Apply was cancelled",
					"AbortError",
				),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}
