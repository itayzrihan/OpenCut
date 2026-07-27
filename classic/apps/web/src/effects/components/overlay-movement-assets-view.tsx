"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import {
	OVERLAY_MOVEMENT_PRESETS,
	type OverlayMovementPreset,
} from "@/effects/overlay-movement-presets";
import { EFFECT_TARGET_ELEMENT_TYPES, CUSTOM_AI_EFFECT_TYPE } from "@/effects";
import { buildEffectElement } from "@/timeline/element-utils";
import { cn } from "@/utils/ui";
import { mediaTimeFromSeconds } from "@/wasm";

export function OverlayMovementView() {
	return (
		<PanelView title="Overlay Movement">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }}
			>
				{OVERLAY_MOVEMENT_PRESETS.map((preset) => (
					<OverlayMovementItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function OverlayMovementItem({ preset }: { preset: OverlayMovementPreset }) {
	const editor = useEditor();
	const duration =
		preset.defaultDurationSeconds !== undefined
			? mediaTimeFromSeconds({ seconds: preset.defaultDurationSeconds })
			: undefined;

	const handleAddToTimeline = () => {
		const element = buildEffectElement({
			effectType: CUSTOM_AI_EFFECT_TYPE,
			name: preset.name,
			startTime: editor.playback.getCurrentTime(),
			duration,
			params: preset.params,
		});
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	};

	return (
		<DraggableItem
			name={preset.name}
			preview={<OverlayMovementPreview preset={preset} />}
			dragData={{
				id: preset.id,
				name: preset.name,
				type: "effect",
				effectType: CUSTOM_AI_EFFECT_TYPE,
				params: preset.params,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
				placement: "layer",
				duration,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function OverlayMovementPreview({ preset }: { preset: OverlayMovementPreset }) {
	const isFlash = preset.spec.flash !== undefined && preset.spec.flash > 0;
	const isShake = preset.spec.shake !== undefined && preset.spec.shake > 0;
	const hasDarken = preset.spec.darken !== undefined && preset.spec.darken > 0;
	const hasVignette =
		preset.spec.vignette !== undefined && preset.spec.vignette > 0;
	const hasAlphaPulse =
		preset.spec.alphaPulse !== undefined && preset.spec.alphaPulse > 0;
	const colorOverlay = preset.spec.colorOverlay;
	const isWhip =
		preset.spec.curve === "whip-left" || preset.spec.curve === "whip-right";

	return (
		<div className="relative flex size-full items-center justify-center overflow-hidden bg-[#101113]">
			<div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] bg-[size:16px_16px]" />
			<div className="absolute inset-3 border border-white/12" />
			<div
				className={cn(
					"absolute h-14 w-20 border border-cyan-300/75 bg-cyan-300/12 shadow-[0_0_20px_rgba(103,232,249,0.22)]",
					isShake && "animate-[movement-shake_900ms_ease-in-out_infinite]",
					isWhip && "animate-[movement-whip_1100ms_ease-in-out_infinite]",
					!isShake &&
						!isWhip &&
						"animate-[movement-zoom_1400ms_ease-in-out_infinite]",
				)}
			/>
			{isFlash && (
				<div className="absolute inset-0 animate-[movement-flash_1200ms_ease-out_infinite] bg-white" />
			)}
			{hasAlphaPulse && (
				<div className="absolute inset-0 animate-[movement-alpha_1250ms_ease-out_infinite] bg-white" />
			)}
			{colorOverlay && (
				<div
					className="absolute inset-0 opacity-25 mix-blend-soft-light"
					style={{ backgroundColor: colorOverlay }}
				/>
			)}
			{hasDarken && <div className="absolute inset-0 bg-black/30" />}
			{hasVignette && (
				<div className="absolute inset-0 bg-[radial-gradient(circle,transparent_34%,rgba(0,0,0,0.72)_100%)]" />
			)}
			<div className="absolute right-3 bottom-3 left-3">
				<div className="truncate text-[11px] font-medium leading-tight text-white">
					{preset.name}
				</div>
				<div className="mt-1 line-clamp-2 text-[9px] leading-tight text-white/65">
					{preset.use}
				</div>
			</div>
			<style>{`
				@keyframes movement-zoom {
					0%,
					100% {
						transform: scale(0.82);
					}
					50% {
						transform: scale(1.18);
					}
				}
				@keyframes movement-shake {
					0%,
					100% {
						transform: translate(0, 0) scale(1.02);
					}
					22% {
						transform: translate(-7px, 3px) scale(1.13) rotate(-2deg);
					}
					42% {
						transform: translate(6px, -4px) scale(1.08) rotate(1.5deg);
					}
					68% {
						transform: translate(-3px, 2px) scale(1.04) rotate(-0.8deg);
					}
				}
				@keyframes movement-whip {
					0%,
					100% {
						transform: translateX(0) scale(0.95) rotate(0deg);
					}
					50% {
						transform: translateX(14px) scale(1.2) rotate(3deg);
					}
				}
				@keyframes movement-flash {
					0% {
						opacity: 0.78;
					}
					20%,
					100% {
						opacity: 0;
					}
				}
				@keyframes movement-alpha {
					0%,
					100% {
						opacity: 0;
					}
					18% {
						opacity: 0.32;
					}
					34% {
						opacity: 0.06;
					}
					48% {
						opacity: 0.22;
					}
				}
			`}</style>
		</div>
	);
}
