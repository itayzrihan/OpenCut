"use client";
import { useState } from "react";
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
import { type FullAutoOptions } from "@/ai/full-auto-edit";
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
	const { startProject } = useBatchEdit();
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
		if (running) return;
		setRunning(true);
		onRunningChange?.(true);
		try {
			await startProject({ editor, options });
			setOpen(false);
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
		<div className="mb-4 space-y-2 rounded-md border p-3">
			<Button
				className="w-full"
				disabled={disabled || running}
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
						<Button
							variant="outline"
							disabled={running}
							onClick={() => setOpen(false)}
						>
							Close
						</Button>
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
