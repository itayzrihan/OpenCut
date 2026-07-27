"use client";

import Image from "next/image";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { buildGraphicPreviewUrl } from "@/graphics";
import { buildGraphicElement } from "@/timeline/element-utils";
import {
	UI_ELEMENT_DEFINITION_ID,
	UI_ELEMENT_PRESETS,
	type UiElementPreset,
} from "@/ui-elements/catalog";

export function UiElementsView() {
	return (
		<PanelView title="UI Elements">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				{UI_ELEMENT_PRESETS.map((preset) => (
					<UiElementPresetItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function UiElementPresetItem({ preset }: { preset: UiElementPreset }) {
	const editor = useEditor();
	const previewUrl = buildGraphicPreviewUrl({
		definitionId: UI_ELEMENT_DEFINITION_ID,
		params: preset.params,
		size: 256,
	});

	const handleAddToTimeline = () => {
		const element = buildGraphicElement({
			definitionId: UI_ELEMENT_DEFINITION_ID,
			name: preset.name,
			startTime: editor.playback.getCurrentTime(),
			params: preset.params,
		});
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "graphic" },
			element,
		});
	};

	return (
		<DraggableItem
			name={preset.name}
			preview={
				<div className="relative size-full bg-black">
					<Image
						src={previewUrl}
						alt=""
						className="size-full object-cover"
						width={256}
						height={256}
						unoptimized
					/>
					<div className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-1">
						<p className="truncate text-[10px] leading-none text-white/85">
							{preset.description}
						</p>
					</div>
				</div>
			}
			dragData={{
				id: preset.id,
				name: preset.name,
				type: "graphic",
				definitionId: UI_ELEMENT_DEFINITION_ID,
				params: preset.params,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			variant="card"
			containerClassName="w-full"
		/>
	);
}
