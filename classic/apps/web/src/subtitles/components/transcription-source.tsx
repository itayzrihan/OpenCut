"use client";
import { useState } from "react";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from "@/components/ui/dialog";
import {
	getExternalSettings,
	type ExternalSettingsView,
} from "@/transcription/external-client";
import { toast } from "sonner";
export function TranscriptionSource({
	disabled,
	onImport,
}: {
	disabled: boolean;
	onImport: () => void;
}) {
	const editor = useEditor();
	const engine = useEditorProject(
		(e) => e.project.getActive().transcriptionEngine ?? "local",
	);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [config, setConfig] = useState<ExternalSettingsView>({
		endpoint: "https://api.openai.com/v1/audio/transcriptions",
		model: "whisper-1",
		configured: false,
	});
	const [key, setKey] = useState("");
	const [error, setError] = useState("");
	const openSettings = async () => {
		setBusy(true);
		setError("");
		setKey("");
		try {
			setConfig(await getExternalSettings());
			setOpen(true);
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Could not read API settings",
			);
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/transcription/settings", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-OpenCut-Account": window.__opencutAccountId ?? "",
				},
				body: JSON.stringify({
					endpoint: config.endpoint,
					model: config.model,
					...(key ? { apiKey: key } : {}),
				}),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error);
			setConfig(result);
			setKey("");
			setOpen(false);
			toast.success("Transcription API settings saved");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save API settings");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2 rounded-lg border p-3">
			<label className="text-sm font-medium" htmlFor="transcription-engine">
				Transcription engine
			</label>
			<Select
				value={engine}
				disabled={disabled || busy}
				onValueChange={(value) => {
					if (value === "local" || value === "external") {
						setBusy(true);
						void editor.transcription
							.setEngine(value)
							.catch((e) => toast.error(e.message))
							.finally(() => setBusy(false));
					}
				}}
			>
				<SelectTrigger
					id="transcription-engine"
					aria-label="Transcription engine"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="local">Local · this device</SelectItem>
					<SelectItem value="external">External API</SelectItem>
				</SelectContent>
			</Select>
			{engine === "external" ? (
				<>
					<Button
						variant="outline"
						size="sm"
						disabled={disabled || busy}
						onClick={() => void openSettings()}
					>
						API settings
					</Button>
					<p className="text-xs text-muted-foreground">
						Audio is sent to your configured API in short sections. Provider
						charges may apply. ChatGPT sign-in does not supply an API key.
					</p>
				</>
			) : (
				<p className="text-xs text-muted-foreground">
					Audio stays on this device. The speech model downloads on first use.
				</p>
			)}
			<Button variant="outline" disabled={disabled || busy} onClick={onImport}>
				Import SRT instead of transcribing
			</Button>
			<p className="text-xs text-muted-foreground">
				SRT replaces transcript captions and is used by Smart takes and Auto
				Texts. Cue times are preserved; word times are estimated.
			</p>
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!busy) {
						setOpen(value);
						if (!value) setKey("");
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Transcription API settings</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<label className="text-sm" htmlFor="transcription-api-endpoint">
							Transcriptions endpoint
							<Input
								id="transcription-api-endpoint"
								aria-label="Transcriptions endpoint"
								value={config.endpoint}
								onChange={(e) =>
									setConfig({ ...config, endpoint: e.target.value })
								}
								disabled={busy}
							/>
						</label>
						<label className="text-sm" htmlFor="transcription-api-model">
							Model
							<Input
								id="transcription-api-model"
								aria-label="Transcription model"
								value={config.model}
								onChange={(e) =>
									setConfig({ ...config, model: e.target.value })
								}
								disabled={busy}
							/>
						</label>
						<p className="text-xs text-muted-foreground">
							Use an OpenAI-compatible model that returns word timestamps with
							verbose_json, such as whisper-1.
						</p>
						<label className="text-sm" htmlFor="transcription-api-key">
							API key
							<Input
								id="transcription-api-key"
								aria-label="Transcription API key"
								type="password"
								autoComplete="off"
								value={key}
								placeholder={
									config.configured
										? "Saved — leave blank to keep"
										: "Enter API key"
								}
								onChange={(e) => setKey(e.target.value)}
								disabled={busy}
							/>
						</label>
						<p className="text-xs text-muted-foreground">
							Stored by the server for your account, separately from project
							files.
						</p>
						{error && (
							<p role="alert" className="text-sm text-red-500">
								{error}
							</p>
						)}
					</div>
					<DialogFooter>
						<Button onClick={() => void save()} disabled={busy}>
							{busy ? "Saving…" : "Save API settings"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
