"use client";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Film, ListVideo, Scissors, TextSelect, X } from "lucide-react";
import { toast } from "@/i18n/toast";
import {
	useEditor,
	useEditorSelection,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { SettingsInfo } from "@/editor-agent/settings-info";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getPodcastTask } from "../podcast-task";
import type { PodcastMode } from "../podcast-types";
const modes = [
	{
		mode: "teaser",
		label: "Create a teaser",
		icon: Film,
		description:
			"Find moments across the episode and combine questions, contrasts and highlights into a short teaser. The reviewed teaser is saved as a new sequence.",
	},
	{
		mode: "highlights",
		label: "Smart podcast clips",
		icon: Scissors,
		description:
			"Find strong ideas with a clear opening, an example or a twist, and a worthwhile ending. Each clip is reviewed and saved as a new scene.",
	},
	{
		mode: "chronological",
		label: "Clips in source order",
		icon: ListVideo,
		description:
			"Select complete answers and stories, trim repetition, and review cuts in source order. Each clip is saved as a new scene.",
	},
	{
		mode: "teleprompter",
		label: "Teleprompter cuts",
		icon: TextSelect,
		description:
			"Trim repetition and false starts while keeping unique sentences and script order. Each video gets a new scene with alternate takes for each sentence.",
	},
] as const;
export function PodcastControls({
	disabled = false,
	onRunningChange,
}: {
	disabled?: boolean;
	onRunningChange?: (running: boolean) => void;
}) {
	const editor = useEditor();
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const task = getPodcastTask(editor);
	const status = useSyncExternalStore(
		task.subscribe,
		task.getSnapshot,
		task.getSnapshot,
	);
	const running = status.status === "running";
	useEffect(() => onRunningChange?.(running), [running, onRunningChange]);
	const [mode, setMode] = useState<PodcastMode | null>(null);
	const [seconds, setSeconds] = useState(60);
	const [count, setCount] = useState(24);
	const [showTakes, setShowTakes] = useState(false);
	const selected = modes.find((m) => m.mode === mode);
	const selectedElements = useEditorSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const reference = useMemo(() => {
		if (!scene) return null;
		try {
			return editor.command.podcastScope(
				selectedElements.map((e) => e.elementId),
			);
		} catch {
			return null;
		}
	}, [editor, scene, selectedElements]);
	const unavailable = !reference;

	const run = async () => {
		if (!mode) return;
		setMode(null);
		try {
			await task.start({
				mode,
				minSeconds:
					mode === "teleprompter"
						? 0
						: mode === "teaser"
							? Math.max(20, seconds - 15)
							: 20,
				maxSeconds:
					mode === "teleprompter" ? 0 : mode === "teaser" ? seconds : 90,
				maxOutputs:
					mode === "teleprompter" ? 32 : mode === "teaser" ? 1 : count,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="mb-4 space-y-3 rounded-md border p-3">
			<p className="text-xs text-muted-foreground">
				{selectedElements.length ? (
					<UiMessage
						text={
							"Source: selected clip ranges, with their camera angles and synced audio."
						}
					/>
				) : (
					<UiMessage
						text={"Source: the active timeline, including the multicam edit."}
					/>
				)}
			</p>
			<div className="grid grid-cols-1 gap-2 @min-[300px]:grid-cols-2">
				{modes.map((item) => (
					<div key={item.mode} className="space-y-1">
						<Button
							className="h-auto min-h-9 w-full whitespace-normal"
							variant="outline"
							disabled={disabled || running || unavailable}
							onClick={() => setMode(item.mode)}
						>
							<item.icon className="size-4" />
							{item.label}
						</Button>
						<SettingsInfo>
							<p className="text-xs text-muted-foreground">
								{item.description}
							</p>
						</SettingsInfo>
					</div>
				))}
			</div>
			{scene?.podcastExtract && (
				<div className="space-y-1 rounded border p-2 text-xs" dir="auto">
					<p className="font-medium">{scene.podcastExtract.title}</p>
					<Button
						variant="outline"
						size="sm"
						disabled={running}
						onClick={() =>
							void editor.scenes.switchToScene({
								sceneId: scene.podcastExtract!.sourceSceneId,
							})
						}
					>
						<UiMessage text={"Open the source scene to create another edit"} />
					</Button>
					<p>
						<UiMessage text={"Opening hook:"} />{" "}
						{scene.podcastExtract.openingHook}
					</p>
					<p>
						<UiMessage text={"Ending hook:"} />{" "}
						{scene.podcastExtract.endingHook}
					</p>
					{scene.podcastExtract.options.mode === "teleprompter" &&
						scene.takeAssembly && (
							<details
								className="space-y-2"
								onToggle={(event) => setShowTakes(event.currentTarget.open)}
							>
								<summary className="cursor-pointer">
									<UiMessage text={"Alternate takes by sentence ("} />
									{
										scene.takeAssembly.plan.groups.filter(
											(g) => g.alternatives.length > 1 || g.reviewOnly,
										).length
									}
									)
								</summary>
								{showTakes &&
									scene.takeAssembly.plan.groups.map(
										(group, groupIndex) =>
											(group.alternatives.length > 1 || group.reviewOnly) && (
												<label key={groupIndex} className="block space-y-1">
													<span>
														{group.label}
														{group.reviewOnly ? (
															<>
																{" "}
																<UiMessage text={"· Saved for review"} />
															</>
														) : (
															""
														)}
													</span>
													<select
														className="w-full rounded border bg-background p-2"
														aria-label={`Take: ${group.label}`}
														disabled={running}
														value={group.reviewOnly ? "review" : group.selected}
														onChange={(event) => {
															try {
																editor.command.selectSmartTake({
																	groupIndex,
																	alternativeIndex: Number(event.target.value),
																});
															} catch (error) {
																toast.error(
																	error instanceof Error
																		? error.message
																		: String(error),
																);
															}
														}}
													>
														{group.reviewOnly && (
															<UiLocalized<"option">
																element={"option"}
																messageProps={["children"]}
																value="review"
																disabled
															>
																{"Saved for review"}
															</UiLocalized>
														)}
														{group.alternatives.map((alternative, index) => (
															<option key={index} value={index}>
																{index + 1}. {alternative.label} —{" "}
																{alternative.reason}
															</option>
														))}
													</select>
												</label>
											),
									)}
							</details>
						)}
					{!!scene.takeAssembly?.quality?.unverifiedBoundaries && (
						<p role="status" className="text-amber-600">
							<UiMessage text={"Listen to"} />{" "}
							{scene.takeAssembly.quality.unverifiedBoundaries}{" "}
							<UiMessage
								text={"cut points where silence could not be confirmed."}
							/>
						</p>
					)}
				</div>
			)}
			{unavailable && (
				<p className="text-xs text-muted-foreground">
					<UiMessage
						text={
							"Select a scene with video or audio on the timeline to begin."
						}
					/>
				</p>
			)}
			{running && (
				<div className="flex items-center gap-2">
					<Spinner className="size-4" />
					<span
						role="status"
						aria-live="polite"
						className="min-w-0 flex-1 text-xs"
						dir="auto"
					>
						{status.stage}
					</span>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["aria-label"]}
						variant="ghost"
						size="icon"
						aria-label="Cancel podcast analysis"
						onClick={task.cancel}
					>
						<X />
					</UiLocalized>
				</div>
			)}
			{status.status === "succeeded" && (
				<p role="status" className="text-xs">
					<UiMessage text={"Created"} /> {status.outputCount}{" "}
					<UiMessage
						text={
							"editable sequences. Switch between them in Media or from the timeline sequence menu."
						}
					/>
				</p>
			)}
			{status.status === "failed" && (
				<p role="alert" className="text-xs text-destructive" dir="auto">
					{status.error}
				</p>
			)}
			{status.status === "cancelled" && (
				<p role="status" className="text-xs">
					<UiMessage text={"Analysis cancelled. No clips were created."} />
				</p>
			)}
			<Dialog
				open={!!mode}
				onOpenChange={(open) => {
					if (!open) setMode(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{selected?.label}</DialogTitle>
						<DialogDescription>
							{selected?.description}{" "}
							<UiMessage
								text={
									"Each result is saved as a separate sequence. The original episode stays available for future edits."
								}
							/>
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6">
						{mode === "teleprompter" ? (
							<p className="text-sm">
								<UiMessage
									text={
										"Use one recording or several files. The editor detects videos and durations automatically and handles up to 32 scripts per run. Preview alternate takes here or from a clip’s context menu."
									}
								/>
							</p>
						) : mode === "teaser" ? (
							<label
								htmlFor="podcast-teaser-duration"
								className="block space-y-2 text-sm"
							>
								<UiMessage text={"Maximum teaser length (seconds)"} />
								<Input
									id="podcast-teaser-duration"
									type="number"
									min={20}
									max={90}
									value={Number.isFinite(seconds) ? seconds : ""}
									onChange={(event) => setSeconds(event.target.valueAsNumber)}
								/>
							</label>
						) : (
							<label
								htmlFor="podcast-output-count"
								className="block space-y-2 text-sm"
							>
								<UiMessage text={"Maximum number of videos"} />
								<Input
									id="podcast-output-count"
									type="number"
									min={1}
									max={32}
									value={Number.isFinite(count) ? count : ""}
									onChange={(event) => setCount(event.target.valueAsNumber)}
								/>
							</label>
						)}
						<p className="text-xs text-muted-foreground">
							<UiMessage
								text={
									"The editor creates a transcript if needed and keeps it if analysis is cancelled. The number of results depends on the footage. Cut points without confirmed silence are flagged for review."
								}
							/>
						</p>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setMode(null)}>
							<UiMessage text={"Close"} />
						</Button>
						<Button
							disabled={
								mode === "teleprompter"
									? false
									: mode === "teaser"
										? !Number.isInteger(seconds) || seconds < 20 || seconds > 90
										: !Number.isInteger(count) || count < 1 || count > 32
							}
							onClick={() => void run()}
						>
							<UiMessage text={"Create sequences"} />
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
