"use client";

import { classicZoomPresets, sampleAutomaticZoom } from "opencut-wasm";
import { useMemo } from "react";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import { EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { buildEffectElement } from "@/timeline/element-utils";
import { getTrackDisplayIndex } from "@/timeline/track-order";
import { mediaTimeFromSeconds } from "@/wasm";

type Preset = ReturnType<typeof classicZoomPresets>[number];

export function ClassicZooms() {
	const presets = useMemo(() => classicZoomPresets(), []);
	return (
		<section aria-label="Classic Zooms" className="mb-4 border-b pb-4">
			<h3 className="mb-1 text-sm font-medium">Classic Zooms</h3>
			<p className="mb-3 text-xs text-muted-foreground">
				Four camera zoom presets. Drag onto a layer or add at the playhead.
			</p>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }}
			>
				{presets.map((preset) => (
					<ClassicZoomItem key={preset.style} preset={preset} />
				))}
			</div>
		</section>
	);
}

function ClassicZoomItem({ preset }: { preset: Preset }) {
	const editor = useEditor();
	const duration = mediaTimeFromSeconds({ seconds: preset.duration });
	const params = {
		style: preset.style,
		scale: preset.scale,
		attack: preset.attack,
		release: preset.release,
		anchorX: preset.anchorX,
		anchorY: preset.anchorY,
	};
	const curve = useMemo(
		() =>
			Array.from({ length: 61 }, (_, i) => {
				const scale = sampleAutomaticZoom({
					...preset,
					time: (i / 60) * preset.duration,
				});
				return `${8 + (i / 60) * 104},${58 - (scale - 1) * 200}`;
			}).join(" "),
		[preset],
	);
	return (
		<div aria-label={`Classic ${preset.name}`}>
			<DraggableItem
				name={preset.name}
				aspectRatio={1}
				containerClassName="w-full"
				preview={
					<div className="flex size-full flex-col justify-center gap-2 bg-slate-950 p-3 text-white">
						<svg viewBox="0 0 120 70" aria-hidden="true" className="w-full">
							<path d="M8 58H112" stroke="#334155" />
							<polyline
								points={curve}
								fill="none"
								stroke="#a5b4fc"
								strokeWidth="2.5"
							/>
						</svg>
						<span className="text-xs font-medium">{preset.name}</span>
						<span className="text-[10px] text-slate-400">
							{preset.description}
						</span>
					</div>
				}
				dragData={{
					id: `classic-zoom-${preset.style}`,
					name: `Classic ${preset.name}`,
					type: "effect",
					effectType: "automatic-zoom",
					params,
					duration,
					targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
					placement: "layer",
				}}
				onAddToTimeline={({ currentTime }) => {
					const tracks = editor.scenes.getActiveScene().tracks;
					editor.timeline.insertElement({
						placement: {
							mode: "auto",
							trackType: "effect",
							insertIndex: getTrackDisplayIndex({
								tracks,
								trackId: tracks.main.id,
							}),
						},
						element: buildEffectElement({
							effectType: "automatic-zoom",
							name: `Classic ${preset.name}`,
							startTime: currentTime,
							duration,
							params,
						}),
					});
				}}
			/>
		</div>
	);
}
