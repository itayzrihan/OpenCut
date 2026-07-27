"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import {
	OVERLAY_EFFECT_PRESETS,
	OVERLAY_EFFECT_TYPE,
	type OverlayEffectPreset,
} from "@/effects/overlay-presets";
import { EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { buildEffectElement } from "@/timeline/element-utils";

export function OverlayEffectsView() {
	return (
		<PanelView title="Overlay FX">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				{OVERLAY_EFFECT_PRESETS.map((preset) => (
					<OverlayEffectItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function OverlayEffectItem({ preset }: { preset: OverlayEffectPreset }) {
	const editor = useEditor();

	const handleAddToTimeline = () => {
		const element = buildEffectElement({
			effectType: OVERLAY_EFFECT_TYPE,
			name: preset.name,
			startTime: editor.playback.getCurrentTime(),
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
			preview={<OverlayPreview preset={preset} />}
			dragData={{
				id: preset.id,
				name: preset.name,
				type: "effect",
				effectType: OVERLAY_EFFECT_TYPE,
				params: preset.params,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function OverlayPreview({ preset }: { preset: OverlayEffectPreset }) {
	const hue = Math.abs(
		[...preset.id].reduce((total, char) => total + char.charCodeAt(0), 0) % 360,
	);
	return (
		<div
			className="relative flex size-full items-center justify-center overflow-hidden bg-neutral-950"
			style={{
				backgroundImage: `radial-gradient(circle at 30% 25%, hsl(${hue} 90% 62% / 0.75), transparent 35%), radial-gradient(circle at 70% 80%, hsl(${(hue + 92) % 360} 88% 58% / 0.55), transparent 38%), linear-gradient(135deg, #09090b, #1f2937)`,
			}}
		>
			<div
				className="absolute inset-0 opacity-35"
				style={{
					backgroundImage:
						"linear-gradient(rgba(255,255,255,0.10) 1px, transparent 1px)",
					backgroundSize: "100% 9px",
				}}
			/>
			<div className="absolute inset-0 shadow-[inset_0_0_40px_rgba(0,0,0,0.75)]" />
			<div className="relative px-2 text-center">
				<div className="text-[11px] font-medium leading-tight text-white">
					{preset.name}
				</div>
				<div className="mt-1 overflow-hidden text-[9px] leading-tight text-ellipsis text-white/65">
					{preset.use}
				</div>
			</div>
		</div>
	);
}
