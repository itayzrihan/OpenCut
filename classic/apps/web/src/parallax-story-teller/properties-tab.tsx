"use client";

import { Button } from "@/components/ui/button";
import { useEditor, useEditorTimelineScenes } from "@/editor/use-editor";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import {
	PARALLAX_CAMERA_KEYFRAME_PARAMS,
	PARALLAX_CAMERA_KEYFRAME_PATHS,
} from "@/parallax-story-teller/camera-keyframes";
import {
	getCameraAnimationsBeforeCameraMan,
	PARALLAX_CAMERA_MAN_BACKUP_PARAM,
	readParallaxSceneId,
} from "@/parallax-story-teller/model";
import { resolveOverlayMovementCameraState } from "@/effects/overlay-movement-presets";
import type { EffectElement } from "@/timeline";
import {
	ArrowRight,
	Camera,
	Layers3,
	MoveHorizontal,
	Repeat2,
	RotateCcw,
	ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useCameraManStore } from "@/parallax-story-teller/camera-man-store";
import {
	buildParallaxMotionLoopParams,
	PARALLAX_MOTION_LOOP_PRESETS,
	readParallaxMotionLoopSettings,
	type ParallaxMotionLoopSettings,
} from "@/parallax-story-teller/motion-loop";
import { getLoopPreset } from "@/loops/registry";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

export function ParallaxStoryPropertiesTab({
	element,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const editor = useEditor();
	const scenes = useEditorTimelineScenes((value) => value.scenes.getScenes());
	const sceneId = readParallaxSceneId({ params: element.params });
	const scene = scenes.find((candidate) => candidate.id === sceneId);
	const handleEditCanvas = async () => {
		if (!sceneId || !scene) {
			toast.error("This parallax canvas scene is missing");
			return;
		}
		await editor.scenes.switchToScene({ sceneId });
		editor.selection.clearSelection();
		editor.playback.seek({ time: ZERO_MEDIA_TIME });
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 shrink-0 items-center border-b px-3.5">
				<SectionTitle>Parallax Story</SectionTitle>
			</div>
			<div className="space-y-4 p-3.5">
				<div className="overflow-hidden rounded-lg border bg-[linear-gradient(135deg,rgba(34,211,238,0.12),rgba(139,92,246,0.08))] p-3">
					<div className="flex items-center gap-2 text-sm font-medium">
						<Camera className="size-4 text-cyan-300" />
						Canvas Pan
					</div>
					<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
						A nested world scene with its own timeline. Text, images and video
						keep their world position while the camera travels.
					</p>
				</div>
				<Button
					className="h-10 w-full justify-between"
					onClick={() => void handleEditCanvas()}
					disabled={!scene}
				>
					<span className="flex items-center gap-2">
						<Layers3 className="size-4" />
						Edit Canvas
					</span>
					<ArrowRight className="size-4" />
				</Button>
				<div className="space-y-2 rounded-md border p-3 text-xs">
					<div className="flex items-center justify-between gap-3">
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<MoveHorizontal className="size-3.5" />
							Direction
						</span>
						<span className="capitalize">
							{scene?.parallax?.direction ?? "—"}
						</span>
					</div>
					<div className="flex items-center justify-between gap-3">
						<span className="text-muted-foreground">World width</span>
						<span>
							{scene?.parallax?.worldWidthFrames ?? "—"} camera frames
						</span>
					</div>
				</div>
				<div className="rounded-md border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs">
					<div className="flex items-center gap-2 font-medium">
						<Camera className="size-3.5 text-cyan-300" />
						Camera source: Canvas Pan Camera
					</div>
					<p className="mt-1.5 leading-relaxed text-muted-foreground">
						Open Edit Canvas and select the Camera layer to edit its position,
						zoom and keyframes. This story clip only retimes that camera path.
					</p>
				</div>
				<p className="text-[11px] leading-relaxed text-muted-foreground">
					Tip: change this clip’s length on the main timeline to retime the
					camera movement. The inner timeline remains local to the story.
				</p>
			</div>
		</div>
	);
}

export function ParallaxMotionLoopsPropertiesTab({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const editor = useEditor();
	const settings = readParallaxMotionLoopSettings({ params: element.params });
	const durationSeconds = mediaTimeToSeconds({ time: element.duration });
	const enabled = settings.presetId !== "none";
	const update = (patch: Partial<ParallaxMotionLoopSettings>) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						params: buildParallaxMotionLoopParams({
							params: element.params,
							patch,
						}),
					},
				},
			],
		});
	};
	const rangeStartSeconds =
		durationSeconds * (settings.startPercent / 100);
	const rangeEndSeconds = durationSeconds * (settings.endPercent / 100);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 shrink-0 items-center border-b px-3.5">
				<SectionTitle>Motion Loops</SectionTitle>
			</div>
			<div className="space-y-4 p-3.5">
				<div className="rounded-lg border border-violet-400/25 bg-violet-400/10 p-3">
					<div className="flex items-center gap-2 text-sm font-medium">
						<Repeat2 className="size-4 text-violet-300" />
						Parallax Story movement
					</div>
					<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
						Adds a repeating screen-space movement after the inner camera has
						framed the canvas.
					</p>
				</div>

				<SectionField label="Loop style">
					<Select
						value={settings.presetId}
						onValueChange={(presetId) => {
							const preset = getLoopPreset({ id: presetId });
							update({ presetId, cycleSeconds: preset.cycleSeconds });
						}}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PARALLAX_MOTION_LOOP_PRESETS.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									{preset.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SectionField>

				<MotionLoopSlider
					label="Amount"
					value={settings.amount}
					min={0}
					max={2}
					step={0.01}
					disabled={!enabled}
					format={(value) => `${Math.round(value * 100)}%`}
					onChange={(amount) => update({ amount })}
				/>

				<MotionLoopSlider
					label="Cycle duration"
					value={settings.cycleSeconds}
					min={0.1}
					max={12}
					step={0.1}
					disabled={!enabled}
					format={(value) => `${value.toFixed(1)}s`}
					onChange={(cycleSeconds) => update({ cycleSeconds })}
				/>

				<SectionField label="Active range">
					<div className="space-y-3 rounded-md border p-3">
						<Slider
							value={[settings.startPercent, settings.endPercent]}
							min={0}
							max={100}
							step={0.1}
							minStepsBetweenThumbs={1}
							disabled={!enabled}
							onValueChange={([startPercent, endPercent]) => {
								if (startPercent === undefined || endPercent === undefined) return;
								update({ startPercent, endPercent });
							}}
						/>
						<div className="grid grid-cols-2 gap-2">
							<RangeInput
								label="Start"
								value={settings.startPercent}
								disabled={!enabled}
								onChange={(startPercent) => update({ startPercent })}
							/>
							<RangeInput
								label="End"
								value={settings.endPercent}
								disabled={!enabled}
								onChange={(endPercent) => update({ endPercent })}
							/>
						</div>
						<p className="text-[11px] tabular-nums text-muted-foreground">
							{rangeStartSeconds.toFixed(2)}s – {rangeEndSeconds.toFixed(2)}s
						</p>
					</div>
				</SectionField>

				<div className="rounded-md border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs">
					<div className="flex items-center gap-2 font-medium">
						<ShieldCheck className="size-3.5 text-emerald-300" />
						Automatic edge protection
					</div>
					<p className="mt-1.5 leading-relaxed text-muted-foreground">
						Zoom is calculated for every frame from its exact translation,
						rotation and scale, so the main viewport stays fully covered.
					</p>
				</div>
			</div>
		</div>
	);
}

function MotionLoopSlider({
	label,
	value,
	min,
	max,
	step,
	format,
	disabled,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	disabled: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<SectionField label={label}>
			<div className="flex items-center gap-3">
				<Slider
					value={[value]}
					min={min}
					max={max}
					step={step}
					disabled={disabled}
					onValueChange={([next]) => next !== undefined && onChange(next)}
				/>
				<span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
					{format(value)}
				</span>
			</div>
		</SectionField>
	);
}

function RangeInput({
	label,
	value,
	disabled,
	onChange,
}: {
	label: string;
	value: number;
	disabled: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<label className="space-y-1 text-[11px] text-muted-foreground">
			<span>{label} (%)</span>
			<Input
				type="number"
				size="xs"
				min={0}
				max={100}
				step={0.1}
				value={Number(value.toFixed(1))}
				disabled={disabled}
				onChange={(event) => {
					const next = event.currentTarget.valueAsNumber;
					if (Number.isFinite(next)) onChange(next);
				}}
			/>
		</label>
	);
}

export function ParallaxCameraPropertiesTab({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const camera = resolveOverlayMovementCameraState({
		effectParams: element.params,
		animations: element.animations,
		localTime,
		duration: element.duration,
	});

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 shrink-0 items-center border-b px-3.5">
				<SectionTitle>Camera Layer</SectionTitle>
			</div>
			<div className="space-y-4 p-3.5">
				<div className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 p-3 text-xs leading-relaxed text-muted-foreground">
					The world canvas stays fixed. This layer controls only the camera
					window and its keyframes.
				</div>
				<Button
					variant="outline"
					className="w-full gap-2 border-amber-400/30 text-amber-200"
					onClick={() => {
						editor.playback.pause();
						useCameraManStore.getState().reset();
						editor.timeline.updateElements({
							updates: [
								{
									trackId,
									elementId: element.id,
									patch: {
										params: {
											...element.params,
											[PARALLAX_CAMERA_MAN_BACKUP_PARAM]: "",
										},
										animations: getCameraAnimationsBeforeCameraMan({
											params: element.params,
											duration: element.duration,
											currentAnimations: element.animations,
										}),
									},
								},
							],
						});
						toast.success("Camera restored. This action can also be undone.");
					}}
				>
					<RotateCcw className="size-4" /> Undo Camera Man
				</Button>
				<Section
					collapsible
					defaultOpen
					sectionKey={`${element.id}:camera-keyframes`}
				>
					<SectionHeader>
						<SectionTitle>Camera KeyFrames</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<SectionFields>
							{PARALLAX_CAMERA_KEYFRAME_PARAMS.map((param) => (
								<ParallaxCameraParamField
									key={param.key}
									param={param}
									trackId={trackId}
									element={element}
									localTime={localTime}
									isPlayheadWithinElementRange={isPlayheadWithinElementRange}
									camera={camera}
								/>
							))}
						</SectionFields>
					</SectionContent>
				</Section>
			</div>
		</div>
	);
}

function ParallaxCameraParamField({
	param,
	trackId,
	element,
	localTime,
	isPlayheadWithinElementRange,
	camera,
}: {
	param: (typeof PARALLAX_CAMERA_KEYFRAME_PARAMS)[number];
	trackId: string;
	element: EffectElement;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	camera: { x: number; y: number; scale: number };
}) {
	const value =
		param.key === "parallax.cameraX"
			? camera.x
			: param.key === "parallax.cameraY"
				? camera.y
				: camera.scale;
	const propertyPath =
		param.key === "parallax.cameraX"
			? PARALLAX_CAMERA_KEYFRAME_PATHS.x
			: param.key === "parallax.cameraY"
				? PARALLAX_CAMERA_KEYFRAME_PATHS.y
				: PARALLAX_CAMERA_KEYFRAME_PATHS.scale;
	const animated = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		elementStartTime: element.startTime,
		animations: element.animations,
		propertyPath,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue: value,
		buildBaseUpdates: ({ value: nextValue }) => ({
			params: { ...element.params, [param.key]: nextValue },
		}),
	});

	return (
		<PropertyParamField
			param={param}
			value={value}
			onPreview={animated.onPreview}
			onCommit={animated.onCommit}
			keyframe={{
				isActive: animated.isKeyframedAtTime,
				isDisabled: !isPlayheadWithinElementRange,
				onToggle: animated.toggleKeyframe,
				navigation: {
					hasPrevious: animated.hasPreviousKeyframe,
					hasNext: animated.hasNextKeyframe,
					onPrevious: animated.goToPreviousKeyframe,
					onNext: animated.goToNextKeyframe,
				},
			}}
		/>
	);
}
