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
			preview={<SpeakerFrameBreakoutPreview description={preset.description} />}
			dragData={buildSimpleAdvancedLayerDragData({ preset })}
			aspectRatio={9 / 16}
			shouldShowPlusOnDrag={false}
			variant="card"
			containerClassName="w-full [&_button]:hidden"
		/>
	);
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
