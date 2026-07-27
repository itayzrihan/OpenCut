"use client";

import type { CSSProperties } from "react";
import { useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { CUSTOM_AI_EFFECT_TYPE } from "@/effects";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import { VISUAL_ELEMENT_TYPES } from "@/timeline";
import { TRANSITION_PRESETS, type TransitionPreset } from "@/transitions";

type TransitionPreviewStyle = CSSProperties & {
	"--preview-x": string;
	"--preview-y": string;
	"--preview-scale-x": string;
	"--preview-scale-y": string;
	"--preview-rotate": string;
};

export function TransitionsView() {
	return (
		<PanelView title="Transitions">
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))" }}
			>
				{TRANSITION_PRESETS.filter(
					(transition) => transition.id !== "none",
				).map((transition) => (
					<TransitionItem key={transition.id} transition={transition} />
				))}
			</div>
		</PanelView>
	);
}

function TransitionItem({ transition }: { transition: TransitionPreset }) {
	const editor = useEditor();
	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element: buildEffectElement({
				effectType: CUSTOM_AI_EFFECT_TYPE,
				name: `Transition: ${transition.label}`,
				startTime: currentTime,
				params: {
					label: transition.label,
					kind: "transition",
					intent: "Timeline transition adjustment layer",
					transitionId: transition.id,
				},
			}),
		});
	}, [editor, transition.id, transition.label]);

	return (
		<DraggableItem
			name={transition.label}
			preview={<TransitionPreview transition={transition} />}
			dragData={{
				id: transition.id,
				name: transition.label,
				type: "transition",
				transitionId: transition.id,
				targetElementTypes: VISUAL_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function TransitionPreview({ transition }: { transition: TransitionPreset }) {
	const previewStyle = buildPreviewStyle({ transition });
	return (
		<div
			className="transition-preview-root relative flex size-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.14),transparent_32%),linear-gradient(135deg,hsl(var(--muted)),hsl(var(--background)))]"
			style={previewStyle}
		>
			<div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent)] opacity-60 transition-preview-sheen" />
			<div className="relative h-14 w-[4.5rem]">
				<div className="absolute top-2 left-1 h-9 w-10 rounded-sm border border-white/10 bg-foreground/20 shadow-sm transition-preview-out" />
				<div className="absolute right-1 bottom-2 h-9 w-10 rounded-sm border border-primary/60 bg-background shadow-[0_10px_22px_rgba(0,0,0,0.22)] transition-preview-in" />
				<div className="absolute inset-x-1 top-1/2 h-px bg-primary/70" />
				<div className="absolute top-1/2 right-0 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
			</div>
			<span className="sr-only">{transition.label}</span>
			<style>{`
				@keyframes oc-transition-preview-in {
					0% {
						opacity: 0;
						transform: translate(var(--preview-x), var(--preview-y)) scale(var(--preview-scale-x), var(--preview-scale-y)) rotate(var(--preview-rotate));
					}
					58% {
						opacity: 1;
						transform: translate(calc(var(--preview-x) * -0.08), calc(var(--preview-y) * -0.08)) scale(1.03, 1.03) rotate(calc(var(--preview-rotate) * -0.08));
					}
					100% {
						opacity: 1;
						transform: translate(0, 0) scale(1, 1) rotate(0deg);
					}
				}

				@keyframes oc-transition-preview-out {
					0% {
						opacity: 0.58;
						transform: translate(0, 0) scale(1, 1);
					}
					100% {
						opacity: 0.12;
						transform: translate(calc(var(--preview-x) * -0.45), calc(var(--preview-y) * -0.45)) scale(0.9, 0.9);
					}
				}

				@keyframes oc-transition-preview-sheen {
					0% { transform: translateX(-120%); }
					100% { transform: translateX(120%); }
				}

				.transition-preview-in {
					animation: oc-transition-preview-in 1600ms cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
					animation-play-state: paused;
				}

				.transition-preview-out {
					animation: oc-transition-preview-out 1600ms cubic-bezier(0.4, 0, 0.2, 1) infinite;
					animation-play-state: paused;
				}

				.transition-preview-sheen {
					animation: oc-transition-preview-sheen 1600ms ease-in-out infinite;
					animation-play-state: paused;
				}

				.transition-preview-root:hover .transition-preview-in,
				.transition-preview-root:hover .transition-preview-out,
				.transition-preview-root:hover .transition-preview-sheen {
					animation-play-state: running;
				}
			`}</style>
		</div>
	);
}

function buildPreviewStyle({
	transition,
}: {
	transition: TransitionPreset;
}): TransitionPreviewStyle {
	const x =
		readTransitionPreviewValue({
			transition,
			property: "transform.positionX",
		}) ??
		(transition.keywords.includes("left")
			? -160
			: transition.keywords.includes("right")
				? 160
				: 0);
	const y =
		readTransitionPreviewValue({
			transition,
			property: "transform.positionY",
		}) ??
		(transition.keywords.includes("up")
			? -110
			: transition.keywords.includes("down")
				? 110
				: 0);
	const scaleX =
		readTransitionPreviewValue({ transition, property: "transform.scaleX" }) ??
		0.72;
	const scaleY =
		readTransitionPreviewValue({ transition, property: "transform.scaleY" }) ??
		scaleX;
	const rotate =
		readTransitionPreviewValue({ transition, property: "transform.rotate" }) ??
		0;

	return {
		"--preview-x": `${Math.max(-42, Math.min(42, x * 0.18))}px`,
		"--preview-y": `${Math.max(-34, Math.min(34, y * 0.18))}px`,
		"--preview-scale-x": Math.max(
			0.18,
			Math.min(1.7, Math.abs(scaleX)),
		).toString(),
		"--preview-scale-y": Math.max(
			0.18,
			Math.min(1.7, Math.abs(scaleY)),
		).toString(),
		"--preview-rotate": `${Math.max(-36, Math.min(36, rotate))}deg`,
	};
}

function readTransitionPreviewValue({
	transition,
	property,
}: {
	transition: TransitionPreset;
	property: keyof TransitionPreset["state"];
}): number | null {
	const firstRecipeValue = transition.recipe?.[property]?.[0]?.value;
	if (typeof firstRecipeValue === "number") {
		return firstRecipeValue;
	}
	const stateValue = transition.state[property];
	return typeof stateValue === "number" ? stateValue : null;
}
