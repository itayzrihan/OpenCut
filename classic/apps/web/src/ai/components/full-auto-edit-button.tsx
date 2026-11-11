"use client";
import { Message as UiMessage } from "@/i18n/message";
import { BrowserTranscriptionPicker } from "@/transcription/browser-model-picker";
import { DEFAULT_BROWSER_TRANSCRIPTION_MODEL } from "@/transcription/models";
import { BrandKitPicker } from "@/brand-kits/picker";
import { useState } from "react";
import { Loader2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsInfo } from "@/editor-agent/settings-info";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogFooter,
	DialogDescription,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { type FullAutoOptions } from "@/ai/full-auto-edit";
import { toast } from "@/i18n/toast";
import { useBatchEdit } from "@/batch/provider";
import { sceneActions, type SceneAction } from "@/batch/scene-jobs";
import { findSceneCheckpoint } from "@/batch/scene-checkpoint";

export function FullAutoEditButton({
	disabled,
	onRunningChange,
	sceneIds,
	action = "full-auto",
	initialOpen = false,
	onClose,
	hideTrigger = false,
}: {
	disabled: boolean;
	sceneIds?: string[];
	action?: SceneAction;
	initialOpen?: boolean;
	onClose?: () => void;
	hideTrigger?: boolean;
	onRunningChange?: (running: boolean) => void;
}) {
	const editor = useEditor();
	const { startProject, state } = useBatchEdit();
	const projectId = editor.project.getActive().metadata.id;
	const sceneId = editor.scenes.getActiveScene().id;
	const previous = findSceneCheckpoint({
		runs: state.runs.filter(
			(run) => !run.options.action || run.options.action === action,
		),
		projectId,
		sceneId,
	});
	const previousJob = previous?.jobs.find(
		(j) => (j.sourceProjectId ?? j.projectId) === projectId,
	);
	const resumable =
		(previousJob?.status === "failed" ||
			previousJob?.status === "interrupted") &&
		(!!previousJob.sourceProjectId || previousJob.completedStages >= 3);
	const [open, setOpen] = useState(initialOpen);
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	const [options, setOptions] = useState<FullAutoOptions>({
		zoom: false,
		transitions: false,
		wordAnimation: false,
		music: false,
		soundEffects: false,
		browserModel: DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
	});
	const run = async (resume = false) => {
		if (running) return;
		setRunning(true);
		onRunningChange?.(true);
		try {
			await startProject({
				editor,
				sceneIds,
				action,
				options: resume && previous ? previous.options : options,
				...(resume && previous ? { resumeRunId: previous.id } : {}),
			});
			setOpen(false);
			onClose?.();
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Could not queue Full Auto Edit";
			setStatus(message);
			toast.error(message);
		} finally {
			setRunning(false);
			onRunningChange?.(false);
		}
	};

	return (
		<div
			className={
				hideTrigger ? undefined : "mb-4 space-y-2 rounded-md border p-3"
			}
		>
			{!hideTrigger && (
				<Button
					className="h-auto min-h-9 w-full whitespace-normal break-words"
					disabled={disabled || running}
					onClick={() => (resumable ? void run(true) : setOpen(true))}
				>
					<WandSparkles />{" "}
					{resumable ? (
						<UiMessage
							text={"Resume Full Auto Edit · stage {v0}"}
							values={{ v0: String(previousJob.completedStages + 1) }}
						/>
					) : (
						<UiMessage text={"Full Auto Edit"} />
					)}
				</Button>
			)}
			{!hideTrigger && (
				<SettingsInfo>
					<p className="text-xs text-muted-foreground">
						<UiMessage
							text={
								"Vertical framing, smart silence removal, Auto Texts and finishing."
							}
						/>
					</p>
				</SettingsInfo>
			)}
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!running) {
						setOpen(value);
						if (!value) onClose?.();
					}
				}}
			>
				<DialogContent
					className="flex max-h-[90dvh] flex-col overflow-hidden"
					onEscapeKeyDown={(event) => {
						if (running) event.preventDefault();
					}}
					onInteractOutside={(event) => {
						if (running) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{sceneActions.find(([id]) => id === action)?.[1]} ·{" "}
							{sceneIds?.length ?? 1}{" "}
							{sceneIds && sceneIds.length > 1 ? (
								<UiMessage text={"scenes"} />
							) : (
								<UiMessage text={"scene"} />
							)}
						</DialogTitle>
						<DialogDescription>
							<UiMessage
								text={
									"Each scene is processed in the queue. Results are saved as new scenes. You can keep working and switch between scenes."
								}
							/>
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="min-h-0 overflow-y-auto">
						{(action === "full-auto" || action === "auto-texts") && (
							<BrowserTranscriptionPicker
								value={options.browserModel}
								disabled={running}
								onChange={(browserModel) =>
									setOptions((previous) => ({ ...previous, browserModel }))
								}
							/>
						)}
						<BrandKitPicker
							value={options.brandKitId}
							disabled={running}
							onChange={(brandKitId) =>
								setOptions((previous) => ({ ...previous, brandKitId }))
							}
						/>
						{action === "full-auto" &&
							(
								[
									["zoom", "Automatic Zoom"],
									["transitions", "Automatic Transition Edit"],
									["wordAnimation", "Automatic Word Animation and Reveal"],
									["soundEffects", "Automatic Sound Effects · Earshot"],
									["music", "Automatic Music"],
								] as const
							).map(([key, label]) => (
								<label key={key} className="flex items-center gap-3 text-sm">
									<Checkbox
										checked={options[key]}
										disabled={running}
										onCheckedChange={(checked) =>
											setOptions((previous) => ({
												...previous,
												[key]: checked === true,
											}))
										}
									/>
									{label}
								</label>
							))}
						<p className="text-xs text-muted-foreground">
							<UiMessage
								text={
									"Single-row captions · Smart audio cut · protect speech ·"
								}
							/>{" "}
							{options.brandKitId ? (
								<UiMessage text={"Brand Kit fonts"} />
							) : (
								<UiMessage text={"Assistant bold"} />
							)}{" "}
							<UiMessage
								text={
									"· fade 60% / 25%. Local face/body framing uses five source samples per source; no cloud AI is used for centering. Uncertain subjects use centered vertical cover automatically; editing continues."
								}
							/>
						</p>
						{status && (
							<p role="status" className="text-sm whitespace-pre-wrap">
								{status}
							</p>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={running}
							onClick={() => {
								setOpen(false);
								onClose?.();
							}}
						>
							<UiMessage text={"Close"} />
						</Button>
						<Button disabled={running} onClick={() => void run()}>
							{running && <Loader2 className="animate-spin" />}{" "}
							<UiMessage text={"Add to queue"} />
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
