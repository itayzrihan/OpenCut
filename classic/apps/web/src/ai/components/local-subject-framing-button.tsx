"use client";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { runLocalSubjectFraming } from "@/ai/subject-framing";

export function LocalSubjectFramingButton({
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
			const result = await runLocalSubjectFraming({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			setStatus(result.message);
			if (result.added) toast.success("Center Subject Horizontally ready");
			else toast.info(result.message);
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error
						? error.message
						: "Center Subject Horizontally failed";
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
				{running ? <Loader2 className="animate-spin" /> : <Sparkles />} Center
				Subject Horizontally
			</Button>
			<p className="text-muted-foreground text-xs">
				Local face/body detection, no cloud request. Centers existing vertical
				cover clips.
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
					Cancel framing
				</Button>
			)}
		</div>
	);
}
