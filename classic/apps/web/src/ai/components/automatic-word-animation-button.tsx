"use client";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { runAutomaticWordAnimation } from "@/ai/automatic-word-animation";

export function AutomaticWordAnimationButton({
	disabled,
	onRunningChange,
}: {
	disabled: boolean;
	onRunningChange?: (running: boolean) => void;
}) {
	const editor = useEditor();
	const controller = useRef<AbortController | null>(null);
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	useEffect(() => () => controller.current?.abort(), []);
	const run = async () => {
		if (controller.current) return;
		const abort = new AbortController();
		controller.current = abort;
		setRunning(true);
		onRunningChange?.(true);
		try {
			const result = await runAutomaticWordAnimation({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			const message = `${result.wordCount} words · ${result.soundCount} sounds · ${result.coveragePercent.toFixed(0)}% coverage. ${result.summary} Undo restores the previous edit.`;
			setStatus(message);
			toast.success("Automatic Word Animation and Reveal ready");
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error
						? error.message
						: "Automatic Word Animation and Reveal failed";
				setStatus(message);
				toast.error(message);
			}
		} finally {
			controller.current = null;
			setRunning(false);
			onRunningChange?.(false);
		}
	};
	return (
		<div className="mb-4 space-y-2 rounded-md border p-3">
			<Button
				className="h-auto min-h-9 w-full whitespace-normal"
				onClick={run}
				disabled={disabled || running}
			>
				{running ? <Loader2 className="animate-spin" /> : <Sparkles />}{" "}
				Automatic Word Animation and Reveal
			</Button>
			<p className="text-muted-foreground text-xs">
				Rare semantic word accents, up to 10%; exceptional typing reveals with
				sound.
			</p>
			{status && (
				<p role="status" className="text-xs">
					{status}
				</p>
			)}
			{running && (
				<Button
					variant="outline"
					size="sm"
					onClick={() => controller.current?.abort()}
				>
					Cancel word animation
				</Button>
			)}
		</div>
	);
}
