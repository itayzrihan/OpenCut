"use client";
import { Message as UiMessage } from "@/i18n/message";
import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "@/i18n/toast";
import { Button } from "@/components/ui/button";
import { SettingsInfo } from "@/editor-agent/settings-info";
import { useEditor } from "@/editor/use-editor";
import { runAutomaticTextTransitions } from "@/ai/automatic-text-transitions";

export function AutomaticTextTransitionsButton({
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
			const result = await runAutomaticTextTransitions({
				editor,
				signal: abort.signal,
				onProgress: setStatus,
			});
			const message = `${result.textCount} texts · ${result.soundCount} sounds · ${result.coveragePercent.toFixed(0)}% coverage. Undo restores the previous edit.`;
			setStatus(message);
			toast.success("Automatic Transitions ready");
		} catch (error) {
			if (abort.signal.aborted) setStatus("Cancelled — timeline unchanged.");
			else {
				const message =
					error instanceof Error
						? error.message
						: "Automatic Transitions failed";
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
		<div className="min-w-0 space-y-2 rounded-md border p-2">
			<Button
				className="h-auto min-h-9 w-full whitespace-normal"
				onClick={run}
				disabled={disabled || running}
			>
				{running ? <Loader2 className="animate-spin" /> : <Sparkles />}{" "}
				<UiMessage text={"Automatic Transitions"} />
			</Button>
			<SettingsInfo>
				<p className="text-muted-foreground text-xs">
					<UiMessage
						text={
							"Text entrances and exits in the Galya / Shemi style, with matched sounds."
						}
					/>
				</p>
			</SettingsInfo>
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
					<UiMessage text={"Cancel transitions"} />
				</Button>
			)}
		</div>
	);
}
