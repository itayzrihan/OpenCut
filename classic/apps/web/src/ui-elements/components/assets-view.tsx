"use client";

import Image from "next/image";
import { Sparkles } from "lucide-react";
import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { generateUiElementPreset } from "@/ai/preset-generation";
import { BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
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
import { useEditor } from "@/editor/use-editor";
import { buildGraphicPreviewUrl } from "@/graphics";
import { useSharedLibraryStore } from "@/shared-library";
import { buildGraphicElement } from "@/timeline/element-utils";
import type { TimelineDragData } from "@/timeline/drag";
import { buildUiElementBundleTimelineItems } from "@/ui-elements/bundle";
import {
	UI_ELEMENT_DEFINITION_ID,
	UI_ELEMENT_PRESETS,
	type UiElementPreset,
} from "@/ui-elements/catalog";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

export function UiElementsView() {
	const { generatedUiElements, loadLibrary } = useSharedLibraryStore();
	const presets: UiElementPreset[] = [
		...generatedUiElements.map((preset) => ({
			id: preset.id,
			name: preset.name,
			description: preset.description,
			category: preset.category,
			keywords: preset.keywords,
			whenToUse: preset.whenToUse,
			defaultDurationSeconds: preset.defaultDurationSeconds,
			params: preset.params,
		})),
		...UI_ELEMENT_PRESETS,
	];

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	return (
		<PanelView title="UI Elements" actions={<AiUiElementButton />}>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				{presets.map((preset) => (
					<UiElementPresetItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function AiUiElementButton() {
	const { saveGeneratedUiElement } = useSharedLibraryStore();
	const [isOpen, setIsOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);

	const handleGenerate = async () => {
		const request = prompt.trim();
		if (!request || isGenerating) return;
		setIsGenerating(true);
		try {
			const preset = await generateUiElementPreset({ prompt: request });
			const saved = await saveGeneratedUiElement(preset);
			if (saved) {
				toast.success("AI UI element saved for reuse");
				setPrompt("");
				setIsOpen(false);
			}
		} catch (error) {
			console.error("Failed to generate AI UI element:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to generate AI UI element",
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
					<DialogTitle>Create reusable UI element</DialogTitle>
					<DialogDescription>
						Describe a compact product-style overlay. OpenCut will give it
						editable settings, semantic motion, and save it in UI Elements.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="A black goal card showing $25,000 with blue progress at 68%"
						rows={4}
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="text" onClick={() => setIsOpen(false)}>
						Cancel
					</Button>
					<Button onClick={() => void handleGenerate()} disabled={isGenerating}>
						{isGenerating ? "Generating..." : "Create & save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function UiElementPresetItem({ preset }: { preset: UiElementPreset }) {
	const editor = useEditor();
	const duration = mediaTimeFromSeconds({
		seconds: preset.defaultDurationSeconds,
	});
	const previewUrl = buildGraphicPreviewUrl({
		definitionId: UI_ELEMENT_DEFINITION_ID,
		params: preset.params,
		size: 256,
	});
	const bundleItems = preset.bundle
		? buildUiElementBundleTimelineItems({
				bundle: preset.bundle,
				startTime: ZERO_MEDIA_TIME,
			})
		: null;
	const dragData: TimelineDragData = bundleItems
		? {
				id: preset.id,
				name: preset.name,
				type: "element-bundle",
				anchorElementType: "graphic",
				duration,
				items: bundleItems,
			}
		: {
				id: preset.id,
				name: preset.name,
				type: "graphic",
				definitionId: UI_ELEMENT_DEFINITION_ID,
				params: preset.params,
				duration,
			};

	const handleAddToTimeline = () => {
		if (preset.bundle) {
			const commands = buildUiElementBundleTimelineItems({
				bundle: preset.bundle,
				startTime: editor.playback.getCurrentTime(),
			}).map(
				({ element, trackType }) =>
					new InsertElementCommand({
						element,
						placement: { mode: "auto", trackType },
					}),
			);
			editor.command.execute({ command: new BatchCommand(commands) });
			return;
		}

		const element = buildGraphicElement({
			definitionId: UI_ELEMENT_DEFINITION_ID,
			name: preset.name,
			startTime: editor.playback.getCurrentTime(),
			duration,
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
					{preset.id === "color-reveal-whoosh" ? (
						<div className="relative size-full overflow-hidden bg-[linear-gradient(90deg,#777_0_20%,#32a6ff_20%_100%)]">
							<div className="absolute inset-y-0 left-[20%] w-[3px] bg-white shadow-[0_0_8px_3px_rgba(255,255,255,0.8)]" />
							<div className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-1 text-[9px] font-medium tracking-wide text-white">
								3S REVEAL
							</div>
						</div>
					) : (
						<Image
							src={previewUrl}
							alt=""
							className="size-full object-cover"
							width={256}
							height={256}
							unoptimized
						/>
					)}
					{preset.bundle?.audio.length ? (
						<div
							className="absolute bottom-8 right-2 flex size-6 items-center justify-center rounded-full bg-black/65 text-white/90"
							title="Includes sound effects"
							aria-label="Includes sound effects"
						>
							<HugeiconsIcon icon={VolumeHighIcon} size={14} />
						</div>
					) : null}
					<div className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-1">
						<p className="truncate text-[10px] leading-none text-white/85">
							{preset.description}
						</p>
					</div>
				</div>
			}
			dragData={dragData}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			variant="card"
			containerClassName="w-full"
		/>
	);
}
