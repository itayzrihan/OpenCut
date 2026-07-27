"use client";

import { useEffect, useState } from "react";
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
import { useEditor } from "@/editor/use-editor";
import {
	BACKGROUND_PRESETS,
	type BackgroundPreset,
} from "@/backgrounds/presets";
import { generateBackgroundPreset } from "@/ai/preset-generation";
import { buildGraphicPreviewUrl } from "@/graphics";
import { buildGraphicElement } from "@/timeline/element-utils";
import { useSharedLibraryStore } from "@/shared-library";
import Image from "next/image";
import { Sparkles } from "lucide-react";

const BACKGROUND_DEFINITION_ID = "preset-background";

export function BackgroundsView() {
	const { generatedBackgrounds, loadLibrary } = useSharedLibraryStore();
	const presets: BackgroundPreset[] = [
		...generatedBackgrounds.map((preset) => ({
			id: preset.id,
			name: preset.name,
			description: preset.description,
			params: preset.params,
		})),
		...BACKGROUND_PRESETS,
	];

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	return (
		<PanelView title="Backgrounds" actions={<AiBackgroundButton />}>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))" }}
			>
				{presets.map((preset) => (
					<BackgroundPresetItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function AiBackgroundButton() {
	const { saveGeneratedBackground } = useSharedLibraryStore();
	const [isOpen, setIsOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);

	const handleGenerate = async () => {
		const request = prompt.trim();
		if (!request || isGenerating) return;
		setIsGenerating(true);
		try {
			const preset = await generateBackgroundPreset({ prompt: request });
			const saved = await saveGeneratedBackground(preset);
			if (saved) {
				toast.success("AI background saved");
				setPrompt("");
				setIsOpen(false);
			}
		} catch (error) {
			console.error("Failed to generate AI background:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to generate AI background",
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
					<DialogTitle>Create AI background</DialogTitle>
					<DialogDescription>
						Generate an editable OpenCut background preset from a prompt.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder="Clean cyber grid with teal highlights and subtle motion"
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

function BackgroundPresetItem({ preset }: { preset: BackgroundPreset }) {
	const editor = useEditor();
	const previewUrl = buildGraphicPreviewUrl({
		definitionId: BACKGROUND_DEFINITION_ID,
		params: preset.params,
		size: 256,
	});

	const handleAddToTimeline = () => {
		const element = buildGraphicElement({
			definitionId: BACKGROUND_DEFINITION_ID,
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
				<div className="relative size-full">
					<Image
						src={previewUrl}
						alt=""
						className="size-full object-cover"
						width={256}
						height={144}
						unoptimized
					/>
					<div className="absolute inset-x-0 bottom-0 bg-black/45 px-1.5 py-1">
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
				definitionId: BACKGROUND_DEFINITION_ID,
				params: preset.params,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={16 / 9}
			variant="card"
			containerClassName="w-full"
		/>
	);
}
