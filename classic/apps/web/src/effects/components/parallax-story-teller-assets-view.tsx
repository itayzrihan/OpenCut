"use client";

import { useState } from "react";
import { toast } from "sonner";
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
} from "@/components/ui/dialog";
import { useEditor, useEditorTimelineScenes } from "@/editor/use-editor";
import {
	getDefaultCanvasPanSetup,
	type CanvasPanSetup,
	type ParallaxTemplateId,
} from "@/parallax-story-teller/model";
import { CreateCanvasPanStoryCommand } from "@/commands/parallax/create-canvas-pan-story";
import { cn } from "@/utils/ui";

type StoryType = "blank" | "pan" | "zoom-in" | "zoom-out" | "dolly" | "tour" | "speaker";

const STORY_TYPES: Array<{
	id: ParallaxTemplateId;
	name: string;
	use: string;
	type: StoryType;
}> = [
	{
		id: "blank",
		name: "Blank Parallax",
		use: "An empty unlimited world with a camera layer; build every depth plane yourself",
		type: "blank",
	},
	{
		id: "canvas-pan",
		name: "Canvas Pan",
		use: "Move between stations on a wide world",
		type: "pan",
	},
	{
		id: "zoom-in-parallax",
		name: "Zoom In Parallax",
		use: "Move through depth with foreground planes traveling farther",
		type: "zoom-in",
	},
	{
		id: "zoom-out-parallax",
		name: "Zoom Out Parallax",
		use: "Pull back from layered planes to reveal the larger world",
		type: "zoom-out",
	},
	{
		id: "dolly-through",
		name: "Dolly Through",
		use: "Push through a foreground object into the next scene",
		type: "dolly",
	},
	{
		id: "world-canvas-tour",
		name: "World Canvas Tour",
		use: "Visit several designed stations in one continuous route",
		type: "tour",
	},
	{
		id: "speaker-on-world",
		name: "Speaker on World",
		use: "Place a speaker tile or breakout inside the designed world",
		type: "speaker",
	},
];

export function ParallaxStoryTellerView() {
	const [wizardOpen, setWizardOpen] = useState(false);
	const [selectedTemplate, setSelectedTemplate] =
		useState<ParallaxTemplateId>("canvas-pan");
	return (
		<PanelView title="Parallax Story Teller">
			<div
				className="grid gap-2 pb-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))" }}
			>
				{STORY_TYPES.map((story) => (
					<StoryTypeCard
						key={story.id}
						story={story}
						enabled={true}
						onSelect={() => {
							setSelectedTemplate(story.id);
							setWizardOpen(true);
						}}
					/>
				))}
			</div>
			<CanvasPanWizard
				key={selectedTemplate}
				open={wizardOpen}
				onOpenChange={setWizardOpen}
				templateId={selectedTemplate}
			/>
			<style>{`
				@keyframes story-zoom-in-back {
					0%,
					100% { transform: scale(1); }
					50% { transform: scale(1.06); }
				}
				@keyframes story-zoom-in-mid {
					0%,
					100% { transform: scale(1); }
					50% { transform: scale(1.18); }
				}
				@keyframes story-zoom-in-front {
					0%,
					100% { transform: translate(0, 0) scale(1); }
					50% { transform: translate(-8px, 5px) scale(1.38); }
				}
				@keyframes story-zoom-out-back {
					0%,
					100% { transform: scale(1.06); }
					50% { transform: scale(1); }
				}
				@keyframes story-zoom-out-mid {
					0%,
					100% { transform: scale(1.18); }
					50% { transform: scale(1); }
				}
				@keyframes story-zoom-out-front {
					0%,
					100% { transform: translate(-8px, 5px) scale(1.38); }
					50% { transform: translate(0, 0) scale(1); }
				}
			`}</style>
		</PanelView>
	);
}

function StoryTypeCard({
	story,
	enabled,
	onSelect,
}: {
	story: (typeof STORY_TYPES)[number];
	enabled: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className={cn(
				"group relative min-w-0 select-none overflow-hidden rounded-md border bg-card/60 text-left transition",
				enabled
					? "cursor-pointer hover:border-cyan-300/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
					: "cursor-not-allowed opacity-60",
			)}
			aria-disabled={!enabled}
			disabled={!enabled}
			onClick={onSelect}
			title={enabled ? "Create a Canvas Pan story" : "Coming soon"}
		>
			<div className="aspect-square overflow-hidden border-b bg-[#0d1016]">
				<StoryThumbnail type={story.type} />
			</div>
			<div className="p-2">
				<div className="truncate text-[11px] font-medium text-foreground">
					{story.name}
				</div>
				<div className="mt-1 line-clamp-2 min-h-7 text-[9px] leading-tight text-muted-foreground">
					{story.use}
				</div>
				<div className={cn("mt-2 text-[9px] font-medium uppercase tracking-[0.12em]", enabled ? "text-cyan-300" : "text-muted-foreground/70")}>
					{enabled ? "Create story" : "Soon"}
				</div>
			</div>
		</button>
	);
}

function CanvasPanWizard({
	open,
	onOpenChange,
	templateId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	templateId: ParallaxTemplateId;
}) {
	const editor = useEditor();
	useEditorTimelineScenes((value) => value.scenes.getActiveSceneOrNull());
	const [step, setStep] = useState<1 | 2>(1);
	const [setup, setSetup] = useState<CanvasPanSetup>(() => ({
			...getDefaultCanvasPanSetup(),
			templateId,
			worldWidthFrames: templateId === "world-canvas-tour" ? 6 : 3,
			worldHeightFrames: templateId === "world-canvas-tour" ? 3 : 1,
		}));

	const handleOpenChange = (nextOpen: boolean) => {
		onOpenChange(nextOpen);
		if (!nextOpen) setStep(1);
	};

	const handleCreate = () => {
		const parentScene = editor.scenes.getActiveSceneOrNull();
		if (!parentScene) {
			toast.error("Open a scene before creating a parallax story");
			return;
		}
		if (parentScene.parallax) {
			toast.error("Nested parallax stories are not supported yet");
			return;
		}
		const command = new CreateCanvasPanStoryCommand({
			parentSceneId: parentScene.id,
			startTime: editor.playback.getCurrentTime(),
			setup,
		});
		editor.command.execute({ command });
		toast.success("Parallax story created", {
			description: "Select Edit Canvas in Properties to design the world.",
		});
		handleOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Parallax Story Wizard</DialogTitle>
					<DialogDescription>
						Step {step} of 2 · Create a nested world with its own timeline.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{step === 1 ? (
						<div className="space-y-3">
							<div className="text-sm font-medium">Where should the camera travel?</div>
							<div className="grid grid-cols-2 gap-2">
								{(["right", "left"] as const).map((direction) => (
									<button
										type="button"
										key={direction}
										onClick={() => setSetup((value) => ({ ...value, direction }))}
										className={cn(
											"rounded-md border p-4 text-left text-sm transition",
											setup.direction === direction
												? "border-cyan-300/70 bg-cyan-300/10 text-cyan-100"
												: "hover:bg-muted/50",
										)}
									>
										<div className="font-medium capitalize">Pan {direction}</div>
										<div className="mt-1 text-xs text-muted-foreground">Start in the center and reveal the world on the {direction}.</div>
									</button>
								))}
							</div>
						</div>
					) : (
						<div className="space-y-4">
							<label className="block space-y-1.5 text-sm">
								<span className="font-medium">Story duration</span>
								<div className="flex items-center gap-2">
									<input className="h-9 w-full rounded-md border bg-background px-3" type="range" min="2" max="30" step="0.5" value={setup.durationSeconds} onChange={(event) => setSetup((value) => ({ ...value, durationSeconds: Number(event.target.value) }))} />
									<span className="w-12 text-right tabular-nums">{setup.durationSeconds}s</span>
								</div>
							</label>
							<label className="block space-y-1.5 text-sm">
								<span className="font-medium">World width</span>
								<input
									className="h-9 w-full rounded-md border bg-background px-3"
									type="number"
									min="1"
									step="1"
									value={setup.worldWidthFrames}
									onChange={(event) => setSetup((value) => ({
										...value,
										worldWidthFrames: Math.max(1, Number(event.target.value) || 1),
									}))}
								/>
							</label>
							<label className="block space-y-1.5 text-sm">
								<span className="font-medium">World height</span>
								<input
									className="h-9 w-full rounded-md border bg-background px-3"
									type="number"
									min="1"
									step="1"
									value={setup.worldHeightFrames ?? 1}
									onChange={(event) => setSetup((value) => ({
										...value,
										worldHeightFrames: Math.max(1, Number(event.target.value) || 1),
									}))}
								/>
							</label>
							<div className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
								After creation, select the clip and choose <span className="font-medium text-foreground">Edit Canvas</span>. Every layer you place there is pinned to world coordinates.
							</div>
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					{step === 2 && <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>}
					<Button onClick={() => (step === 1 ? setStep(2) : handleCreate())}>
						{step === 1 ? "Continue" : "Create Parallax Story"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function StoryThumbnail({ type }: { type: StoryType }) {
	return (
		<div className="relative size-full overflow-hidden">
			<div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] bg-[size:18px_18px]" />
			<div className="absolute inset-3 rounded border border-white/12" />
			{type === "pan" && <PanThumbnail />}
			{type === "blank" && <BlankThumbnail />}
			{type === "zoom-in" && <ZoomParallaxThumbnail direction="in" />}
			{type === "zoom-out" && <ZoomParallaxThumbnail direction="out" />}
			{type === "dolly" && <DollyThumbnail />}
			{type === "tour" && <TourThumbnail />}
			{type === "speaker" && <SpeakerThumbnail />}
		</div>
	);
}

function BlankThumbnail() {
	return (
		<div className="absolute inset-0 flex items-center justify-center">
			<div className="h-16 w-10 rounded border-2 border-cyan-300/70 shadow-[0_0_20px_rgba(103,232,249,0.18)]" />
			<div className="absolute bottom-4 text-[8px] uppercase tracking-[0.2em] text-white/55">
				blank world
			</div>
		</div>
	);
}

function PanThumbnail() {
	return (
		<div className="absolute inset-y-0 left-0 flex w-[180%] items-center gap-8 pl-5 animate-[story-pan_3s_ease-in-out_infinite]">
			<Station className="bg-cyan-300/25" />
			<Station className="bg-violet-300/25" />
			<Station className="bg-amber-300/25" />
		</div>
	);
}

function ZoomParallaxThumbnail({ direction }: { direction: "in" | "out" }) {
	return (
		<div className="absolute inset-0">
			<div
				className={cn(
					"absolute inset-6 rounded border border-emerald-200/30 bg-emerald-300/10",
					direction === "in"
						? "animate-[story-zoom-in-back_2.8s_ease-in-out_infinite]"
						: "animate-[story-zoom-out-back_2.8s_ease-in-out_infinite]",
				)}
			/>
			<div
				className={cn(
					"absolute inset-10 rounded border border-blue-200/45 bg-blue-300/15",
					direction === "in"
						? "animate-[story-zoom-in-mid_2.8s_ease-in-out_infinite]"
						: "animate-[story-zoom-out-mid_2.8s_ease-in-out_infinite]",
				)}
			/>
			<div
				className={cn(
					"absolute right-8 bottom-12 h-12 w-8 rotate-12 rounded bg-orange-300/65 shadow-[0_0_18px_rgba(253,186,116,0.35)]",
					direction === "in"
						? "animate-[story-zoom-in-front_2.8s_ease-in-out_infinite]"
						: "animate-[story-zoom-out-front_2.8s_ease-in-out_infinite]",
				)}
			/>
			<div className="absolute right-3 bottom-3 left-3 text-center text-[8px] uppercase tracking-[0.16em] text-white/60">
				{direction === "in" ? "forward depth" : "world reveal"}
			</div>
		</div>
	);
}

function DollyThumbnail() {
	return (
		<div className="absolute inset-0 flex items-center justify-center">
			<div className="absolute h-24 w-24 rounded-full border-8 border-fuchsia-300/45 animate-[story-dolly_2.6s_ease-in-out_infinite]" />
			<div className="h-12 w-16 rounded border border-cyan-200/60 bg-cyan-300/25" />
			<div className="absolute bottom-4 text-[8px] uppercase tracking-[0.2em] text-white/60">
				deeper world
			</div>
		</div>
	);
}

function TourThumbnail() {
	return (
		<div className="absolute inset-0">
			<div className="absolute top-1/2 right-6 left-6 h-px bg-white/35" />
			<div className="absolute top-[calc(50%-3px)] left-[18%] size-1.5 rounded-full bg-cyan-200 shadow-[0_0_10px_rgba(165,243,252,0.8)]" />
			<div className="absolute top-[calc(50%-3px)] left-[46%] size-1.5 rounded-full bg-violet-200 shadow-[0_0_10px_rgba(221,214,254,0.8)]" />
			<div className="absolute top-[calc(50%-3px)] left-[76%] size-1.5 rounded-full bg-amber-200 shadow-[0_0_10px_rgba(253,230,138,0.8)]" />
			<div className="absolute top-[28%] left-[13%] h-7 w-9 rounded border border-cyan-200/40 bg-cyan-300/15" />
			<div className="absolute top-[62%] left-[40%] h-7 w-9 rounded border border-violet-200/40 bg-violet-300/15" />
			<div className="absolute top-[25%] left-[70%] h-7 w-9 rounded border border-amber-200/40 bg-amber-300/15" />
			<div className="absolute inset-x-8 bottom-3 text-center text-[8px] uppercase tracking-[0.18em] text-white/60">
				world route
			</div>
		</div>
	);
}

function SpeakerThumbnail() {
	return (
		<div className="absolute inset-0 flex items-center justify-center">
			<div className="absolute bottom-8 h-16 w-24 rounded-lg border border-white/25 bg-white/10" />
			<div className="absolute bottom-14 h-16 w-12 rounded-full border border-cyan-200/65 bg-cyan-300/20" />
			<div className="absolute bottom-2 left-1/2 h-8 w-px -translate-x-1/2 bg-cyan-200/60" />
			<div className="absolute right-3 bottom-3 left-3 text-center text-[8px] uppercase tracking-[0.16em] text-white/60">
				speaker tile
			</div>
		</div>
	);
}

function Station({ className }: { className?: string }) {
	return (
		<div className={cn("h-16 w-20 shrink-0 rounded border border-white/25", className)} />
	);
}
