"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BACKGROUND_PRESETS, type BackgroundPreset } from "@/backgrounds/presets";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useEditor } from "@/editor/use-editor";
import type { ParamValues } from "@/params";
import {
	backgroundRemovalService,
	useBackgroundRemovalStatus,
} from "@/services/background-removal";
import { useSharedLibraryStore } from "@/shared-library";
import type { EffectElement } from "@/timeline/types";
import {
	buildSpeakerFrameBackgroundSnapshot,
	buildSpeakerFrameLegacySourceSignatures,
	buildSpeakerFrameSourceSignature,
	getSpeakerFrameSourceBindings,
	isSpeakerFrameBreakoutAppliedAndCurrent,
	readSpeakerFrameBreakoutFade,
	readSpeakerFrameBreakoutSettings,
} from "../speaker-frame-breakout";

type ApplyProgress = {
	completedFrames: number;
	totalFrames: number;
};

export function SpeakerFrameBreakoutPropertiesTab({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const editor = useEditor();
	const modelStatus = useBackgroundRemovalStatus();
	const { generatedBackgrounds, loadLibrary } = useSharedLibraryStore();
	const [draft, setDraft] = useState<ParamValues>(() =>
		buildSpeakerFrameBreakoutDraftParams({ element }),
	);
	const [draftSource, setDraftSource] = useState(() => ({
		elementId: element.id,
		params: element.params,
		transitions: element.transitions,
		startTime: element.startTime,
		duration: element.duration,
	}));
	const [isApplying, setIsApplying] = useState(false);
	const [progress, setProgress] = useState<ApplyProgress | null>(null);
	const applyController = useRef<AbortController | null>(null);

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	if (
		!isApplying &&
		(draftSource.elementId !== element.id ||
			draftSource.params !== element.params ||
			draftSource.transitions !== element.transitions ||
			draftSource.startTime !== element.startTime ||
			draftSource.duration !== element.duration)
	) {
		setDraftSource({
			elementId: element.id,
			params: element.params,
			transitions: element.transitions,
			startTime: element.startTime,
			duration: element.duration,
		});
		setDraft(buildSpeakerFrameBreakoutDraftParams({ element }));
	}

	useEffect(
		() => () => {
			applyController.current?.abort();
		},
		[],
	);

	const backgrounds = useMemo<BackgroundPreset[]>(() => {
		const combined = [
			...generatedBackgrounds.map((preset) => ({
				id: preset.id,
				name: preset.name,
				description: preset.description,
				params: preset.params,
			})),
			...BACKGROUND_PRESETS,
		];
		const seen = new Set<string>();
		return combined.filter((preset) => {
			if (seen.has(preset.id)) return false;
			seen.add(preset.id);
			return true;
		});
	}, [generatedBackgrounds]);

	const scene = editor.scenes.getActiveSceneOrNull();
	const persistedDraft = buildSpeakerFrameBreakoutDraftParams({ element });
	const persistedSettings = readSpeakerFrameBreakoutSettings({
		params: persistedDraft,
	});
	const persistedBindings = scene
		? getSpeakerFrameSourceBindings({
				tracks: scene.tracks,
				smartTrackId: trackId,
				layer: element,
			})
		: [];
	const persistedSignature = buildSpeakerFrameSourceSignature({
		layer: element,
		bindings: persistedBindings,
		mediaAssets: editor.media.getAssets(),
		settings: persistedSettings,
	});
	const persistedLegacySignatures = buildSpeakerFrameLegacySourceSignatures({
		layer: element,
		bindings: persistedBindings,
		mediaAssets: editor.media.getAssets(),
		settings: persistedSettings,
		maxTrackIndexShift: scene?.tracks.length ?? 0,
	});
	const isAppliedAndCurrent = isSpeakerFrameBreakoutAppliedAndCurrent({
		layer: element,
		signature: persistedSignature,
		legacySignatures: persistedLegacySignatures,
	});
	const hasPreparedOutput =
		persistedSettings.matteCacheKey.length > 0 &&
		backgroundRemovalService.isPreparedGroupComplete({
			groupKey: persistedSettings.matteCacheKey,
		});
	const isDirty = !areParamValuesEqual({
		left: draft,
		right: persistedDraft,
	});
	const applyRequired = !isAppliedAndCurrent || isDirty;

	const updateNumber = ({ key, value }: { key: string; value: number }) =>
		setDraft((current) => ({ ...current, [key]: value }));
	const draftNumber = ({
		key,
		fallback,
	}: {
		key: string;
		fallback: number;
	}) => readDraftNumber({ params: draft, key, fallback });
	const updateBackground = (presetId: string) => {
		const preset = backgrounds.find((entry) => entry.id === presetId);
		if (!preset) return;
		setDraft((current) => ({
			...current,
			...buildSpeakerFrameBackgroundSnapshot({
				presetId: preset.id,
				params: preset.params,
			}),
		}));
	};

	const apply = async () => {
		if (isApplying) return;
		const controller = new AbortController();
		applyController.current = controller;
		setIsApplying(true);
		setProgress({ completedFrames: 0, totalFrames: 1 });
		try {
			const result = await editor.timeline.applySpeakerFrameBreakout({
				trackId,
				elementId: element.id,
				params: draft,
				signal: controller.signal,
				onProgress: setProgress,
			});
			toast.success(
				`Speaker Frame Breakout ready · ${result.preparedFrames} cached mattes`,
			);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				toast.info("Speaker Frame Breakout Apply cancelled");
			} else {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to apply Speaker Frame Breakout",
				);
			}
		} finally {
			if (applyController.current === controller) {
				applyController.current = null;
			}
			setIsApplying(false);
			setProgress(null);
		}
	};

	const percent = progress
		? Math.round(
				(progress.completedFrames / Math.max(1, progress.totalFrames)) * 100,
			)
		: 0;

	return (
		<div className="flex h-full flex-col">
			<div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b bg-background/95 px-3.5 backdrop-blur">
				<SectionTitle>Speaker Frame Breakout</SectionTitle>
				<div className="ml-auto flex items-center gap-1.5">
					{isApplying ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => applyController.current?.abort()}
						>
							Cancel
						</Button>
					) : (
						<>
							<Button
								variant="ghost"
								size="sm"
								disabled={!isDirty}
								onClick={() =>
									setDraft(buildSpeakerFrameBreakoutDraftParams({ element }))
								}
							>
								Reset
							</Button>
							<Button
								size="sm"
								disabled={!applyRequired || persistedBindings.length === 0}
								onClick={() => void apply()}
							>
								{!applyRequired && persistedSettings.matteApplied
									? "Applied"
									: persistedSettings.matteApplied
										? "Reapply"
										: "Apply"}
							</Button>
						</>
					)}
				</div>
			</div>

			<Section showTopBorder={false} sectionKey={`${element.id}:smart-status`}>
				<SectionHeader>
					<SectionTitle>Prepared effect</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<p className="text-xs leading-relaxed text-muted-foreground">
							The layer binds to the nearest visible video underneath it.
							Background removal runs only when you press Apply.
						</p>
						<SmartLayerStatus
							hasSource={persistedBindings.length > 0}
							isDirty={isDirty}
							isAppliedAndCurrent={isAppliedAndCurrent}
							hasPreparedOutput={hasPreparedOutput}
							backend={persistedSettings.appliedBackend}
						/>
						{isApplying && progress && (
							<div className="flex flex-col gap-1.5">
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>Preparing person mattes</span>
									<span>
										{progress.completedFrames}/{progress.totalFrames}
									</span>
								</div>
								<Progress value={percent} />
							</div>
						)}
						{modelStatus.state === "loading" && !isApplying && (
							<div className="flex flex-col gap-1.5">
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>Loading local model</span>
									<span>{modelStatus.progress}%</span>
								</div>
								<Progress value={modelStatus.progress} />
							</div>
						)}
						{modelStatus.state === "error" && (
							<div className="flex flex-col items-start gap-2">
								<p className="text-xs text-destructive">
									{modelStatus.message}
								</p>
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										void backgroundRemovalService.retry().catch(() => undefined)
									}
								>
									Retry model
								</Button>
							</div>
						)}
					</SectionFields>
				</SectionContent>
			</Section>

			<Section sectionKey={`${element.id}:smart-background`}>
				<SectionHeader>
					<SectionTitle>Background</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<SectionField label="Preset">
							<Select
								value={String(draft.backgroundPresetId ?? "paper-grid")}
								onValueChange={updateBackground}
								disabled={isApplying}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{backgrounds.map((background) => (
										<SelectItem key={background.id} value={background.id}>
											{background.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>
				</SectionContent>
			</Section>

			<Section sectionKey={`${element.id}:smart-layout`}>
				<SectionHeader>
					<SectionTitle>Speaker frame</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<NumberSlider
							label="Horizontal position"
							value={draftNumber({ key: "positionX", fallback: 0 })}
							min={-960}
							max={960}
							step={10}
							format={(value) => `${Math.round(value)} px`}
							onChange={(value) =>
								updateNumber({ key: "positionX", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Vertical position"
							value={draftNumber({ key: "positionY", fallback: 410 })}
							min={-540}
							max={1080}
							step={10}
							format={(value) => `${Math.round(value)} px`}
							onChange={(value) =>
								updateNumber({ key: "positionY", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Scale"
							value={draftNumber({ key: "scaleX", fallback: 0.7 })}
							min={0.2}
							max={1.5}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								setDraft((current) => ({
									...current,
									scaleX: value,
									scaleY: value,
								}))
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Frame top crop"
							value={draftNumber({ key: "cropTop", fallback: 0.22 })}
							min={0}
							max={0.8}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								updateNumber({ key: "cropTop", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Corner radius"
							value={draftNumber({ key: "cornerRadius", fallback: 0.08 })}
							min={0}
							max={0.3}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								updateNumber({ key: "cornerRadius", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Fade in"
							value={draftNumber({
								key: "fadeInDuration",
								fallback: 0.35,
							})}
							min={0}
							max={2}
							step={0.05}
							format={(value) => `${value.toFixed(2)} s`}
							onChange={(value) =>
								updateNumber({ key: "fadeInDuration", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Fade out"
							value={draftNumber({
								key: "fadeOutDuration",
								fallback: 0.35,
							})}
							min={0}
							max={2}
							step={0.05}
							format={(value) => `${value.toFixed(2)} s`}
							onChange={(value) =>
								updateNumber({ key: "fadeOutDuration", value })
							}
							disabled={isApplying}
						/>
					</SectionFields>
				</SectionContent>
			</Section>

			<Section sectionKey={`${element.id}:smart-matte`}>
				<SectionHeader>
					<SectionTitle>Person matte</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<SectionField label="Quality">
							<Select
								value={String(draft.matteQuality ?? "precise")}
								onValueChange={(matteQuality) =>
									setDraft((current) => ({ ...current, matteQuality }))
								}
								disabled={isApplying}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="fast">Fast · 256px</SelectItem>
									<SelectItem value="balanced">Balanced · 384px</SelectItem>
									<SelectItem value="precise">Precise · 512px</SelectItem>
								</SelectContent>
							</Select>
						</SectionField>
						<NumberSlider
							label="Mask threshold"
							value={draftNumber({ key: "maskThreshold", fallback: 0.5 })}
							min={0.05}
							max={0.95}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								updateNumber({ key: "maskThreshold", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Edge detail"
							value={draftNumber({ key: "edgeContrast", fallback: 1 })}
							min={0.5}
							max={2.5}
							step={0.05}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								updateNumber({ key: "edgeContrast", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Edge feather"
							value={draftNumber({ key: "edgeFeather", fallback: 0.5 })}
							min={0}
							max={8}
							step={0.25}
							format={(value) => `${value.toFixed(2)} px`}
							onChange={(value) =>
								updateNumber({ key: "edgeFeather", value })
							}
							disabled={isApplying}
						/>
						<NumberSlider
							label="Temporal stability"
							value={draftNumber({
								key: "temporalSmoothing",
								fallback: 0.24,
							})}
							min={0}
							max={0.85}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onChange={(value) =>
								updateNumber({ key: "temporalSmoothing", value })
							}
							disabled={isApplying}
						/>
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}

function SmartLayerStatus({
	hasSource,
	isDirty,
	isAppliedAndCurrent,
	hasPreparedOutput,
	backend,
}: {
	hasSource: boolean;
	isDirty: boolean;
	isAppliedAndCurrent: boolean;
	hasPreparedOutput: boolean;
	backend: string;
}) {
	if (!hasSource) {
		return (
			<p className="text-xs text-destructive">
				No visible video is located below this layer.
			</p>
		);
	}
	if (isDirty) {
		return (
			<p className="text-xs text-amber-500">
				Settings changed · press Reapply to commit the new look.
			</p>
		);
	}
	if (!isAppliedAndCurrent) {
		return (
			<p className="text-xs text-amber-500">
				Apply required · the layer range or source has changed.
			</p>
		);
	}
	if (!hasPreparedOutput) {
		return (
			<p className="text-xs text-emerald-500">
				Ready; mattes will restore automatically during preview and export.
			</p>
		);
	}
	return (
		<p className="text-xs text-emerald-500">
			Ready for smooth playback{backend ? ` · ${backend.toUpperCase()}` : ""}
		</p>
	);
}

function NumberSlider({
	label,
	value,
	min,
	max,
	step,
	format,
	onChange,
	disabled,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	onChange: (value: number) => void;
	disabled?: boolean;
}) {
	return (
		<SectionField label={label}>
			<div className="flex items-center gap-3">
				<Slider
					value={[value]}
					min={min}
					max={max}
					step={step}
					onValueChange={([next]) => next !== undefined && onChange(next)}
					disabled={disabled}
				/>
				<span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
					{format(value)}
				</span>
			</div>
		</SectionField>
	);
}

function readDraftNumber({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValues;
	right: ParamValues;
}): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (leftKeys.length !== rightKeys.length) return false;
	for (let index = 0; index < leftKeys.length; index++) {
		const key = leftKeys[index];
		if (key !== rightKeys[index] || left[key] !== right[key]) return false;
	}
	return true;
}

function buildSpeakerFrameBreakoutDraftParams({
	element,
}: {
	element: EffectElement;
}): ParamValues {
	return {
		...element.params,
		...readSpeakerFrameBreakoutFade({ element }),
	};
}
