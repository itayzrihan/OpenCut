"use client";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { runAutomaticMusic } from "@/ai/automatic-music";

export function AutomaticMusicButton({
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
			const result = await runAutomaticMusic({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			setStatus(result.message);
			if (result.added) toast.success("Automatic Music ready");
			else toast.info(result.message);
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error ? error.message : "Automatic Music failed";
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
				Automatic Music
			</Button>
			<p className="text-muted-foreground text-xs">
				Local Music matched to the video, cut to its full length at −28 dB.
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
					Cancel music
				</Button>
			)}
		</div>
	);
}
