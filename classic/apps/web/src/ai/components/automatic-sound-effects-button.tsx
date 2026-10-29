"use client";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { runAutomaticSoundEffects } from "@/ai/automatic-sound-effects";

export function AutomaticSoundEffectsButton({
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
			const result = await runAutomaticSoundEffects({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			const message = `${result.soundCount} sounds. ${result.summary} Undo restores the previous edit.`;
			setStatus(message);
			toast.success("Automatic Sound Effects ready");
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error
						? error.message
						: "Automatic Sound Effects failed";
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
				Automatic Sound Effects
			</Button>
			<p className="text-muted-foreground text-xs">
				Earshot sounds directed for the edit, with editable code, pitch,
				duration and echo.
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
					Cancel sound direction
				</Button>
			)}
		</div>
	);
}
