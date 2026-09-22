"use client";
import { useRef, useState } from "react";
import { Loader2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogFooter,
	DialogDescription,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { runFullAutoEdit, type FullAutoOptions } from "@/ai/full-auto-edit";
import { toast } from "sonner";
import { useBatchEdit } from "@/batch/provider";

export function FullAutoEditButton({
	disabled,
	onRunningChange,
}: {
	disabled: boolean;
	onRunningChange?: (running: boolean) => void;
}) {
	const editor = useEditor();
	const { single, setSingle } = useBatchEdit();
	const singleRunning = single?.status === "running";
	const controller = useRef<AbortController | null>(null);
	const [open, setOpen] = useState(false);
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	const [options, setOptions] = useState<FullAutoOptions>({
		zoom: false,
		transitions: false,
		wordAnimation: false,
		music: false,
	});
	const run = async () => {
		if (controller.current || singleRunning) return;
		const abort = new AbortController();
		controller.current = abort;
		setRunning(true);
		setOpen(false);
		const project = editor.project.getActive();
		setSingle({
			updatedAt: Date.now(),
			id: crypto.randomUUID(),
			projectId: project.metadata.id,
			name: project.metadata.name,
			options,
			status: "running",
			completedStages: 0,
			message: "Starting Full Auto Edit…",
			cancel: () => abort.abort(),
		});
		onRunningChange?.(true);
		try {
			const notes = await runFullAutoEdit({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
				onStep: (p) =>
					setSingle((prev) =>
						prev
							? {
									...prev,
									updatedAt: Date.now(),
									completedStages: p.completedStages,
									message: p.message,
								}
							: prev,
					),
				options,
			});
			setStatus(
				[
					"Saved. Review captions, speech cuts and framing before export. Each completed stage supports Undo.",
					...notes,
				].join("\n"),
			);
			setSingle((prev) =>
				prev
					? {
							...prev,
							status: "completed",
							updatedAt: Date.now(),
							message: "Saved · ready for review",
						}
					: prev,
			);
			toast.success("Full Auto Edit ready for review");
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Full Auto Edit failed";
			setStatus(message);
			setSingle((prev) =>
				prev
					? {
							...prev,
							status: abort.signal.aborted ? "cancelled" : "failed",
							updatedAt: Date.now(),
							message,
						}
					: prev,
			);
			toast.error(message);
		} finally {
			controller.current = null;
			setRunning(false);
			onRunningChange?.(false);
		}
	};
	return (
		<div className="mb-4 space-y-2 rounded-md border p-3">
			<Button
				className="w-full"
				disabled={disabled || running || singleRunning}
				onClick={() => setOpen(true)}
			>
				<WandSparkles /> Full Auto Edit
			</Button>
			<p className="text-xs text-muted-foreground">
				Vertical framing, silence removal, complete Hebrew Auto Texts and
				finishing.
			</p>
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!running) setOpen(value);
				}}
			>
				<DialogContent
					onEscapeKeyDown={(event) => {
						if (running) event.preventDefault();
					}}
					onInteractOutside={(event) => {
						if (running) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>Full Auto Edit</DialogTitle>
						<DialogDescription>
							Start from imported video in this project. Choose any optional
							finishing steps, or leave all options off.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						{(
							[
								["zoom", "Automatic Zoom"],
								["transitions", "Automatic Transition Edit"],
								["wordAnimation", "Automatic Word Animation and Reveal"],
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
							Hebrew · ivrit-ai large-v3 · 1 row · silence 0.3s · Assistant bold
							· fade 60% / 25%. Local face/body framing uses five source samples
							per source; no cloud AI is used for centering. Uncertain or moving
							subjects stop for review.
						</p>
						{status && (
							<p role="status" className="text-sm whitespace-pre-wrap">
								{status}
							</p>
						)}
					</div>
					<DialogFooter>
						{running ? (
							<Button
								variant="outline"
								onClick={() => controller.current?.abort()}
							>
								Cancel Full Auto Edit
							</Button>
						) : (
							<Button variant="outline" onClick={() => setOpen(false)}>
								Close
							</Button>
						)}
						<Button disabled={running} onClick={run}>
							{running && <Loader2 className="animate-spin" />}Start Full Auto
							Edit
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
