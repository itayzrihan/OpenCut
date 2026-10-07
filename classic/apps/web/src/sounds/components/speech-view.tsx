"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import type { SpeechRequest, SpeechResponse } from "@/services/speech/worker";

const VOICE_OPTIONS = [
	{ value: "af_heart", label: "Heart · US English" },
	{ value: "am_michael", label: "Michael · US English" },
	{ value: "bf_emma", label: "Emma · UK English" },
	{ value: "bm_george", label: "George · UK English" },
] as const satisfies readonly {
	value: NonNullable<SpeechRequest["voice"]>;
	label: string;
}[];

export function SpeechView() {
	const editor = useEditor();
	const worker = useRef<Worker | null>(null);
	const submittedText = useRef("");
	const transcriptId = useId();
	const [text, setText] = useState("");
	const [voice, setVoice] = useState<SpeechRequest["voice"]>("af_heart");
	const [device, setDevice] = useState<SpeechRequest["device"]>("auto");
	const [busy, setBusy] = useState(false),
		[saving, setSaving] = useState(false);
	const [status, setStatus] = useState(""),
		[error, setError] = useState("");
	const [result, setResult] = useState<{
		blob: Blob;
		url: string;
		transcript: string;
	} | null>(null);
	useEffect(() => () => worker.current?.terminate(), []);
	useEffect(
		() => () => {
			if (result) URL.revokeObjectURL(result.url);
		},
		[result],
	);
	function cancel() {
		worker.current?.terminate();
		worker.current = null;
		setBusy(false);
		setStatus("Cancelled. Downloaded model files stay cached.");
	}
	function generate() {
		setError("");
		setResult(null);
		setBusy(true);
		setStatus("Starting speech engine…");
		if (!worker.current) {
			worker.current = new Worker(
				new URL("../../services/speech/worker.ts", import.meta.url),
				{ type: "module" },
			);
			worker.current.onmessage = ({ data }: MessageEvent<SpeechResponse>) => {
				if (data.type === "status") setStatus(data.message);
				else if (data.type === "error") {
					setError(data.message);
					setBusy(false);
				} else {
					setResult({
						blob: data.audio,
						url: URL.createObjectURL(data.audio),
						transcript: submittedText.current,
					});
					setStatus(
						`Generated on your ${data.device === "webgpu" ? "GPU" : "CPU"}.`,
					);
					setBusy(false);
				}
			};
			worker.current.onerror = () => {
				setError("The speech engine stopped. Try CPU mode or a shorter clip.");
				worker.current?.terminate();
				worker.current = null;
				setBusy(false);
			};
		}
		submittedText.current = text;
		worker.current.postMessage({ text, voice, device } satisfies SpeechRequest);
	}
	async function addToProject() {
		const project = editor.project.getActive();
		if (!result || !project) return;
		setSaving(true);
		setError("");
		try {
			const assets = await processMediaAssets({
				files: [
					new File([result.blob], `Voiceover-${Date.now()}.wav`, {
						type: "audio/wav",
					}),
				],
			});
			if (editor.project.getActive()?.metadata.id !== project.metadata.id)
				throw new Error(
					"The active project changed. Open the intended project and try again.",
				);
			if (assets.length !== 1)
				throw new Error("Could not import generated audio.");
			const added = await editor.media.addMediaAsset({
				projectId: project.metadata.id,
				asset: assets[0],
			});
			if (!added) throw new Error("Could not save the generated voiceover.");
			setStatus("Voiceover added to project media.");
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Could not add voiceover",
			);
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="space-y-4 overflow-y-auto p-4">
			<div>
				<h3 className="font-medium">Create a voiceover</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					English · Kokoro 82M. Runs on this device. The first use downloads
					model files (about 90 MB for CPU or 330 MB for GPU), then reuses the
					browser cache.
				</p>
			</div>
			<label className="block space-y-1 text-sm">
				<span>Text ({text.length}/250)</span>
				<textarea
					value={text}
					maxLength={250}
					disabled={busy}
					onChange={(event) => setText(event.target.value)}
					className="min-h-28 w-full rounded border bg-background p-2"
				/>
			</label>
			<label className="block space-y-1 text-sm">
				<span>Voice</span>
				<select
					value={voice}
					disabled={busy}
					onChange={(event) => {
						const option = VOICE_OPTIONS.find(
							(option) => option.value === event.target.value,
						);
						if (option) setVoice(option.value);
					}}
					className="w-full rounded border bg-background p-2"
				>
					{VOICE_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</label>
			<label className="block space-y-1 text-sm">
				<span>Processor</span>
				<select
					value={device}
					disabled={busy}
					onChange={(event) => {
						const nextDevice = event.target.value;
						if (nextDevice !== "auto" && nextDevice !== "wasm") return;
						worker.current?.terminate();
						worker.current = null;
						setDevice(nextDevice);
					}}
					className="w-full rounded border bg-background p-2"
				>
					<option value="auto">GPU when supported, otherwise CPU</option>
					<option value="wasm">CPU (compatible mode)</option>
				</select>
			</label>
			{busy ? (
				<Button variant="outline" onClick={cancel}>
					Cancel
				</Button>
			) : (
				<Button disabled={!text.trim() || saving} onClick={generate}>
					Generate voiceover
				</Button>
			)}
			{status && (
				<p role="status" className="text-xs">
					{status}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{result && (
				<div className="space-y-3">
					{/* Generated audio has an exact text alternative; the engine does not emit timed caption cues. */}
					{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
					<audio
						controls
						src={result.url}
						aria-describedby={transcriptId}
						className="w-full"
					/>
					<p id={transcriptId} className="whitespace-pre-wrap text-sm">
						{result.transcript}
					</p>
					<Button disabled={saving} onClick={() => void addToProject()}>
						{saving ? "Adding…" : "Add to project media"}
					</Button>
					<a
						href={result.url}
						download="voiceover.wav"
						className="ml-3 text-sm underline"
					>
						Download WAV
					</a>
				</div>
			)}
		</div>
	);
}
