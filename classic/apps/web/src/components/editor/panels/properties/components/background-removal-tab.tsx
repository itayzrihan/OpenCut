"use client";

import { useEffect, useState } from "react";
import {
	getDefaultBackgroundRemovalSettings,
	type BackgroundRemovalMode,
	type BackgroundRemovalQuality,
	type BackgroundRemovalSettings,
} from "@/background-removal";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "@/editor/use-editor";
import {
	backgroundRemovalService,
	useBackgroundRemovalStatus,
} from "@/services/background-removal";
import type { VideoElement } from "@/timeline";
import { cn } from "@/utils/ui";
import {
	areBackgroundRemovalSettingsEqual,
	createBackgroundRemovalDraft,
	shouldResetBackgroundRemovalDraft,
} from "../background-removal-draft";

const MODES: Array<{
	id: BackgroundRemovalMode;
	label: string;
	description: string;
}> = [
	{ id: "remove", label: "Remove", description: "Transparent background" },
	{ id: "blur", label: "Blur", description: "Keep the person sharp" },
	{ id: "grayscale", label: "B&W", description: "Desaturate background" },
];

export function BackgroundRemovalTab({
	element,
	trackId,
}: {
	element: VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const modelStatus = useBackgroundRemovalStatus();
	const persistedSettings = element.backgroundRemoval;
	const [defaultSettings] = useState(() =>
		getDefaultBackgroundRemovalSettings(),
	);
	const [duplicateOnEnable, setDuplicateOnEnable] = useState(false);
	const [draft, setDraft] = useState<BackgroundRemovalSettings>(() =>
		createBackgroundRemovalDraft({ persistedSettings, defaultSettings }),
	);
	const [draftSource, setDraftSource] = useState(() => ({
		elementId: element.id,
		persistedSettings,
	}));

	if (
		shouldResetBackgroundRemovalDraft({
			previousElementId: draftSource.elementId,
			nextElementId: element.id,
			previousSettings: draftSource.persistedSettings,
			nextSettings: persistedSettings,
		})
	) {
		setDraftSource({ elementId: element.id, persistedSettings });
		setDraft(
			createBackgroundRemovalDraft({ persistedSettings, defaultSettings }),
		);
		if (element.id !== draftSource.elementId) {
			setDuplicateOnEnable(false);
		}
	}

	const persistedDraft = createBackgroundRemovalDraft({
		persistedSettings,
		defaultSettings,
	});
	const isDirty = !areBackgroundRemovalSettingsEqual({
		left: draft,
		right: persistedDraft,
	});

	useEffect(() => {
		if (persistedSettings?.enabled) {
			void backgroundRemovalService.preload().catch(() => undefined);
		}
	}, [persistedSettings?.enabled]);

	const applyDraft = () => {
		if (!isDirty) return;
		const target = editor.timeline.setBackgroundRemoval({
			trackId,
			elementId: element.id,
			settings: draft,
			duplicate: !persistedSettings && draft.enabled && duplicateOnEnable,
		});
		if (target && draft.enabled) {
			void backgroundRemovalService.preload().catch(() => undefined);
		}
	};

	const updateDraft = (patch: Partial<BackgroundRemovalSettings>) =>
		setDraft((current) => ({ ...current, ...patch }));

	const cancelDraft = () => {
		setDraft(persistedDraft);
	};

	return (
		<div className="flex h-full flex-col">
			<div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b bg-background/95 px-3.5 backdrop-blur">
				<SectionTitle>Person background</SectionTitle>
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						variant="ghost"
						size="sm"
						disabled={!isDirty}
						onClick={cancelDraft}
					>
						Cancel
					</Button>
					<Button size="sm" disabled={!isDirty} onClick={applyDraft}>
						Apply
					</Button>
				</div>
			</div>

			<Section
				showTopBorder={false}
				sectionKey={`${element.id}:background-removal`}
			>
				<SectionHeader
					trailing={
						<Switch
							checked={draft.enabled}
							onCheckedChange={(enabled) => updateDraft({ enabled })}
							aria-label="Enable person background processing"
						/>
					}
				>
					<SectionTitle>Local AI matte</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Detects people on-device with MODNet. Frames stay local; the model
							downloads once and is cached by the browser.
						</p>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Choose an effect and tuning, then Apply. The complete change is
							stored as one undoable edit.
						</p>

						<div className="grid grid-cols-3 gap-1.5">
							{MODES.map((mode) => (
								<Button
									key={mode.id}
									type="button"
									variant={draft.mode === mode.id ? "secondary" : "outline"}
									className={cn(
										"h-auto min-w-0 flex-col items-start gap-0.5 px-2.5 py-2 text-left",
										draft.mode === mode.id && "border-primary/40 bg-primary/10",
									)}
									onClick={() => updateDraft({ mode: mode.id, enabled: true })}
								>
									<span className="text-xs font-medium">{mode.label}</span>
									<span className="whitespace-normal text-[10px] leading-tight text-muted-foreground">
										{mode.description}
									</span>
								</Button>
							))}
						</div>

						<SectionField label="Quality">
							<Select
								value={draft.quality}
								onValueChange={(quality) => {
									if (isBackgroundRemovalQuality(quality)) {
										updateDraft({ quality });
									}
								}}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="fast">
										Fast · 256px / 15 fps preview
									</SelectItem>
									<SelectItem value="balanced">
										Balanced · 384px / 24 fps
									</SelectItem>
									<SelectItem value="precise">
										Precise · 512px / 30 fps
									</SelectItem>
								</SelectContent>
							</Select>
						</SectionField>

						<TuningSlider
							label="Mask threshold"
							value={draft.maskThreshold}
							min={0.05}
							max={0.95}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onDraft={(maskThreshold) =>
								setDraft((value) => ({ ...value, maskThreshold }))
							}
						/>
						<TuningSlider
							label="Edge detail"
							value={draft.edgeContrast}
							min={0.5}
							max={2.5}
							step={0.05}
							format={(value) => `${Math.round(value * 100)}%`}
							onDraft={(edgeContrast) =>
								setDraft((value) => ({ ...value, edgeContrast }))
							}
						/>
						<TuningSlider
							label="Edge feather"
							value={draft.edgeFeather}
							min={0}
							max={8}
							step={0.25}
							format={(value) => `${value.toFixed(2)} px`}
							onDraft={(edgeFeather) =>
								setDraft((value) => ({ ...value, edgeFeather }))
							}
						/>
						<TuningSlider
							label="Temporal stability"
							value={draft.temporalSmoothing}
							min={0}
							max={0.85}
							step={0.01}
							format={(value) => `${Math.round(value * 100)}%`}
							onDraft={(temporalSmoothing) =>
								setDraft((value) => ({ ...value, temporalSmoothing }))
							}
						/>

						{draft.mode === "blur" && (
							<TuningSlider
								label="Background blur"
								value={draft.blurStrength}
								min={0}
								max={1}
								step={0.01}
								format={(value) => `${Math.round(value * 100)}%`}
								onDraft={(blurStrength) =>
									setDraft((value) => ({ ...value, blurStrength }))
								}
							/>
						)}

						{!persistedSettings && (
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="flex items-start gap-2.5">
									<Checkbox
										id={`duplicate-background-${element.id}`}
										checked={duplicateOnEnable}
										onCheckedChange={(checked) =>
											setDuplicateOnEnable(checked === true)
										}
									/>
									<label
										htmlFor={`duplicate-background-${element.id}`}
										className="cursor-pointer text-xs leading-relaxed"
									>
										Duplicate to a video layer above
										<span className="mt-0.5 block text-muted-foreground">
											Uses a free video track only when it cannot overlap;
											otherwise a new video track is inserted immediately above
											this clip.
										</span>
									</label>
								</div>
							</div>
						)}

						<ModelStatus status={modelStatus} />

						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setDraft({
									...defaultSettings,
									enabled: draft.enabled,
								})
							}
						>
							Reset tuning
						</Button>
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}

function isBackgroundRemovalQuality(
	value: string,
): value is BackgroundRemovalQuality {
	return value === "fast" || value === "balanced" || value === "precise";
}

function TuningSlider({
	label,
	value,
	min,
	max,
	step,
	format,
	onDraft,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	onDraft: (value: number) => void;
}) {
	return (
		<SectionField label={label}>
			<div className="flex items-center gap-3">
				<Slider
					value={[value]}
					min={min}
					max={max}
					step={step}
					onValueChange={([next]) => next !== undefined && onDraft(next)}
				/>
				<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
					{format(value)}
				</span>
			</div>
		</SectionField>
	);
}

function ModelStatus({
	status,
}: {
	status: ReturnType<typeof useBackgroundRemovalStatus>;
}) {
	if (status.state === "idle") {
		return (
			<p className="text-xs text-muted-foreground">Model loads when enabled.</p>
		);
	}
	if (status.state === "loading") {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex justify-between text-xs text-muted-foreground">
					<span>Loading local model</span>
					<span>{status.progress}%</span>
				</div>
				<Progress value={status.progress} />
			</div>
		);
	}
	if (status.state === "error") {
		return (
			<div className="flex flex-col items-start gap-2">
				<p className="text-xs text-destructive">{status.message}</p>
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
		);
	}
	return (
		<p className="text-xs text-muted-foreground">
			Ready ·{" "}
			{status.backend === "webgpu" ? "WebGPU acceleration" : "WASM fallback"}
		</p>
	);
}
