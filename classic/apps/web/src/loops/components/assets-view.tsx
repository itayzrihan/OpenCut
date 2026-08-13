"use client";

import type { CSSProperties } from "react";
import { useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import {
	LOOP_PRESETS,
	LOOP_TARGET_ELEMENT_TYPES,
	isLoopTargetElementType,
	type LoopPreset,
	type LoopProperty,
} from "@/loops";

type LoopPreviewStyle = CSSProperties & {
	"--loop-x": string;
	"--loop-y": string;
	"--loop-scale": string;
	"--loop-rotate": string;
};

export function LoopsView() {
	return (
		<PanelView title="Loops">
			<div className="mb-3 text-xs leading-relaxed text-muted-foreground">
				Drag a loop onto an image, video or text layer. Applying another loop
				replaces the current loop on that layer.
			</div>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}
			>
				{LOOP_PRESETS.map((preset) => (
					<LoopItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function LoopItem({ preset }: { preset: LoopPreset }) {
	const editor = useEditor();
	const applyToSelection = useCallback(() => {
		const applications = editor.selection
			.getSelectedElements()
			.flatMap((selected) => {
				const entry = editor.timeline.getElementsWithTracks({
					elements: [selected],
				})[0];
				if (
					!entry ||
					!isLoopTargetElementType({ elementType: entry.element.type })
				) {
					return [];
				}
				return [
					{
						trackId: selected.trackId,
						elementId: selected.elementId,
						loopId: preset.id,
					},
				];
			});
		if (applications.length > 0) {
			editor.timeline.applyLoops({ applications });
		}
	}, [editor, preset.id]);

	return (
		<DraggableItem
			name={preset.label}
			preview={<LoopPreview preset={preset} />}
			dragData={{
				id: preset.id,
				name: preset.label,
				type: "loop",
				loopId: preset.id,
				targetElementTypes: [...LOOP_TARGET_ELEMENT_TYPES],
			}}
			onAddToTimeline={applyToSelection}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function LoopPreview({ preset }: { preset: LoopPreset }) {
	const previewStyle = buildLoopPreviewStyle({ preset });
	return (
		<div
			className="loop-preview-root relative flex size-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),transparent_34%),linear-gradient(135deg,hsl(var(--muted)),hsl(var(--background)))]"
			style={previewStyle}
		>
			<div className="absolute inset-0 opacity-30 [background-image:linear-gradient(45deg,transparent_45%,hsl(var(--primary)/0.28)_46%,transparent_50%)] [background-size:10px_10px]" />
			<div className="loop-preview-object relative h-12 w-14 rounded-md border border-primary/60 bg-primary/20 shadow-[0_8px_20px_rgba(0,0,0,0.18)]">
				<div className="absolute inset-2 rounded border border-primary/40 bg-background/50" />
				<div className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
			</div>
			<style>{`
				@keyframes oc-loop-preview {
					0%, 100% { transform: translate(var(--loop-x), var(--loop-y)) scale(var(--loop-scale)) rotate(var(--loop-rotate)); opacity: 1; }
					50% { transform: translate(calc(var(--loop-x) * -1), calc(var(--loop-y) * -1)) scale(calc(var(--loop-scale) + 0.08)) rotate(calc(var(--loop-rotate) * -1)); opacity: 0.72; }
				}
				.loop-preview-object { animation: oc-loop-preview 1600ms ease-in-out infinite; animation-play-state: paused; }
				.loop-preview-root:hover .loop-preview-object { animation-play-state: running; }
			`}</style>
			<span className="sr-only">{preset.label}</span>
		</div>
	);
}

function buildLoopPreviewStyle({
	preset,
}: {
	preset: LoopPreset;
}): LoopPreviewStyle {
	const read = (property: LoopProperty) =>
		preset.recipe[property]?.[0]?.value ?? 0;
	const scale = read("transform.scaleX");
	return {
		"--loop-x": `${Math.max(-24, Math.min(24, read("transform.positionX") * 0.25))}px`,
		"--loop-y": `${Math.max(-20, Math.min(20, read("transform.positionY") * 0.25))}px`,
		"--loop-scale": Math.max(0.72, Math.min(1.35, scale || 1)).toString(),
		"--loop-rotate": `${Math.max(-16, Math.min(16, read("transform.rotate")))}deg`,
	};
}
