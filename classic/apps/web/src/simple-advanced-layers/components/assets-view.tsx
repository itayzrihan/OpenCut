"use client";

import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	buildSimpleAdvancedLayerDragData,
	SIMPLE_ADVANCED_LAYER_PRESETS,
	type SimpleAdvancedLayerPreset,
} from "@/simple-advanced-layers/catalog";

export function SimpleAdvancedLayersView() {
	return (
		<PanelView title="simple advanced layers">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				{SIMPLE_ADVANCED_LAYER_PRESETS.map((preset) => (
					<SimpleAdvancedLayerItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function SimpleAdvancedLayerItem({
	preset,
}: {
	preset: SimpleAdvancedLayerPreset;
}) {
	return (
		<DraggableItem
			name={preset.name}
			preview={<PresetPreview preset={preset} />}
			dragData={buildSimpleAdvancedLayerDragData({ preset })}
			aspectRatio={9 / 16}
			shouldShowPlusOnDrag={false}
			variant="card"
			containerClassName="w-full [&_button]:hidden"
		/>
	);
}

function PresetPreview({ preset }: { preset: SimpleAdvancedLayerPreset }) {
	switch (preset.id) {
		case "doubleman":
			return <DoublemanPreview description={preset.description} />;
		case "blur-backdrop":
			return <BlurBackgroundPreview description={preset.description} />;
		case "color-pop-backdrop":
			return <ColorPopPreview description={preset.description} />;
		default:
			return <SpeakerFrameBreakoutPreview description={preset.description} />;
	}
}

function SpeakerFrameBreakoutPreview({ description }: { description: string }) {
	return (
		<div
			className="relative size-full overflow-hidden bg-[#f8f8f5]"
			title={description}
		>
			<div className="absolute inset-0 bg-[linear-gradient(rgba(25,25,25,0.09)_1px,transparent_1px),linear-gradient(90deg,rgba(25,25,25,0.09)_1px,transparent_1px)] bg-[size:12px_12px] [mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]" />
			<div className="absolute inset-x-[13%] bottom-[6%] h-[38%] overflow-hidden rounded-[12%] bg-gradient-to-b from-slate-500 to-slate-900 shadow-md">
				<div className="absolute left-1/2 top-[-12%] h-[56%] w-[38%] -translate-x-1/2 rounded-full bg-[#efc7ad]" />
				<div className="absolute inset-x-[20%] bottom-[-12%] h-[64%] rounded-t-[48%] bg-[#315b89]" />
			</div>
			<div className="absolute left-1/2 bottom-[31%] h-[25%] w-[29%] -translate-x-1/2 rounded-t-full bg-[#efc7ad] shadow-[0_-1px_0_rgba(255,255,255,0.45)]" />
			<div className="absolute left-2 top-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[8px] font-medium tracking-wide text-white">
				APPLY CUTOUT
			</div>
			<div className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-1">
				<p className="truncate text-[9px] leading-none text-white/90">
					Paper Grid / Fade in-out
				</p>
			</div>
		</div>
	);
}

function PersonSilhouette() {
	return (
		<div className="absolute inset-x-[22%] bottom-[8%] h-[70%]">
			<div className="absolute left-1/2 top-0 h-[26%] w-[44%] -translate-x-1/2 rounded-full bg-[#efc7ad]" />
			<div className="absolute inset-x-0 bottom-0 h-[62%] rounded-t-[46%] bg-gradient-to-b from-slate-500 to-slate-800" />
		</div>
	);
}

function DoublemanPreview({ description }: { description: string }) {
	return (
		<div
			className="relative size-full overflow-hidden bg-[linear-gradient(45deg,#e5e5e5_25%,transparent_25%),linear-gradient(-45deg,#e5e5e5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e5e5e5_75%),linear-gradient(-45deg,transparent_75%,#e5e5e5_75%)] bg-[length:14px_14px] bg-[position:0_0,0_7px,7px_-7px,-7px_0] bg-[#fafafa]"
			title={description}
		>
			<PersonSilhouette />
			<div className="absolute left-2 top-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[8px] font-medium tracking-wide text-white">
				DOUBLEMAN
			</div>
			<div className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-1">
				<p className="truncate text-[9px] leading-none text-white/90">
					Same size / Transparent
				</p>
			</div>
		</div>
	);
}

function BlurBackgroundPreview({ description }: { description: string }) {
	return (
		<div className="relative size-full overflow-hidden" title={description}>
			<div className="absolute inset-0 bg-gradient-to-br from-sky-300 via-emerald-200 to-amber-200 blur-[6px]" />
			<PersonSilhouette />
			<div className="absolute left-2 top-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[8px] font-medium tracking-wide text-white">
				BLUR BG
			</div>
			<div className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-1">
				<p className="truncate text-[9px] leading-none text-white/90">
					Person sharp / Backdrop soft
				</p>
			</div>
		</div>
	);
}

function ColorPopPreview({ description }: { description: string }) {
	return (
		<div className="relative size-full overflow-hidden" title={description}>
			<div className="absolute inset-0 bg-gradient-to-br from-neutral-300 via-neutral-400 to-neutral-600 grayscale" />
			<div className="absolute inset-x-[22%] bottom-[8%] h-[70%]">
				<div className="absolute left-1/2 top-0 h-[26%] w-[44%] -translate-x-1/2 rounded-full bg-[#efc7ad]" />
				<div className="absolute inset-x-0 bottom-0 h-[62%] rounded-t-[46%] bg-gradient-to-b from-rose-500 to-indigo-700" />
			</div>
			<div className="absolute left-2 top-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[8px] font-medium tracking-wide text-white">
				COLOR POP
			</div>
			<div className="absolute inset-x-0 bottom-0 bg-black/60 px-1.5 py-1">
				<p className="truncate text-[9px] leading-none text-white/90">
					Backdrop B&amp;W / Person color
				</p>
			</div>
		</div>
	);
}
