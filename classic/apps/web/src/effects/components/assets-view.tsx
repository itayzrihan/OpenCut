"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import type { EffectDefinition } from "@/effects/types";
import { useSharedLibraryStore, type GeneratedEffectPreset } from "@/shared-library";
import { generateEffectPreset } from "@/ai/preset-generation";
import type { ParamValues } from "@/params";
import { Sparkles } from "lucide-react";

export function EffectsView() {
	const effects = effectsRegistry.getAll();
	const { generatedEffects, loadLibrary } = useSharedLibraryStore();

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	return (
		<PanelView title="Effects" actions={<AiEffectButton />}>
			{generatedEffects.length > 0 && (
				<div className="mb-4 flex flex-col gap-2">
					<p className="text-muted-foreground text-xs">AI presets</p>
					<GeneratedEffectsGrid presets={generatedEffects} />
				</div>
			)}
			<EffectsGrid effects={effects} />
		</PanelView>
	);
}

function GeneratedEffectsGrid({
	presets,
}: {
	presets: GeneratedEffectPreset[];
}) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{presets.map((preset) => (
				<GeneratedEffectItem key={preset.id} preset={preset} />
			))}
		</div>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

function EffectPreviewCanvas({
	effectType,
	params = {},
}: {
	effectType: string;
	params?: ParamValues;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params,
					targetCanvas: canvasRef.current,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType, params]);

	return <canvas ref={canvasRef} className="size-full" />;
}

function GeneratedEffectItem({ preset }: { preset: GeneratedEffectPreset }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: preset.effectType,
			startTime: currentTime,
			name: preset.name,
			params: preset.params,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, preset]);

	const preview = (
		<EffectPreviewCanvas effectType={preset.effectType} params={preset.params} />
	);

	return (
		<DraggableItem
			name={preset.name}
			preview={preview}
			dragData={{
				id: preset.id,
				name: preset.name,
				type: "effect",
				effectType: preset.effectType,
				params: preset.params,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: effect.type,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, effect.type]);

	const preview = <EffectPreviewCanvas effectType={effect.type} />;

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}

function AiEffectButton() {
	const { saveGeneratedEffect } = useSharedLibraryStore();
	const [isOpen, setIsOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);

	const handleGenerate = async () => {
		const request = prompt.trim();
		if (!request || isGenerating) return;
		setIsGenerating(true);
		try {
			const preset = await generateEffectPreset({ prompt: request });
			const saved = await saveGeneratedEffect(preset);
			if (saved) {
				toast.success("AI effect saved");
				setPrompt("");
				setIsOpen(false);
			}
		} catch (error) {
			console.error("Failed to generate AI effect:", error);
			toast.error(
				error instanceof Error ? error.message : "Failed to generate AI effect",
			);
		} finally {
			setIsGenerating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button size="sm" variant="ghost">
					<Sparkles className="size-4" />
					AI
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create AI effect</DialogTitle>
					<DialogDescription>
						Generate an editable OpenCut effect preset from a prompt.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="Subtle RGB split with scanlines and a cool blue tint"
						rows={4}
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="text" onClick={() => setIsOpen(false)}>
						Cancel
					</Button>
					<Button onClick={() => void handleGenerate()} disabled={isGenerating}>
						{isGenerating ? "Generating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
