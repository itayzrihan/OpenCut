"use client";
import { useEffect, useRef, useState } from "react";
import { Focus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { runAutomaticZoom } from "@/ai/automatic-zoom";

export function AutomaticZoomButton({ disabled, onRunningChange }: { disabled: boolean; onRunningChange?: (running:boolean)=>void }) {
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
			const result = await runAutomaticZoom({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			const message = `${result.zoomCount} zooms · ${result.soundCount} swishes. Undo restores the previous edit.`;
			setStatus(message);
			toast.success("Automatic Zoom ready");
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error ? error.message : "Automatic Zoom failed";
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
			<Button className="w-full" onClick={run} disabled={disabled || running}>
				{running ? <Loader2 className="animate-spin" /> : <Focus />} Automatic
				Zoom
			</Button>
			<p className="text-muted-foreground text-xs">
				Speech-aware zooms across the video, with automatic swishes.
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
					Cancel zoom
				</Button>
			)}
		</div>
	);
}
