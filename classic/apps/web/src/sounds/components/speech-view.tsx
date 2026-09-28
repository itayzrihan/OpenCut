"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { AddMediaAssetCommand } from "@/commands/media";
import type { SpeechRequest, SpeechResponse } from "@/services/speech/worker";

export function SpeechView() {
	const editor = useEditor();
	const worker = useRef<Worker | null>(null);
	const [text, setText] = useState("");
	const [voice, setVoice] = useState<SpeechRequest["voice"]>("af_heart");
	const [device, setDevice] = useState<SpeechRequest["device"]>("auto");
	const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
	const [status, setStatus] = useState(""), [error, setError] = useState("");
	const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null);
	useEffect(() => () => worker.current?.terminate(), []);
	useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
	function cancel() { worker.current?.terminate(); worker.current = null; setBusy(false); setStatus("Cancelled. Downloaded model files stay cached."); }
	function generate() {
		setError(""); setResult(null); setBusy(true); setStatus("Starting speech engine…");
		if (!worker.current) {
			worker.current = new Worker(new URL("../../services/speech/worker.ts", import.meta.url), { type: "module" });
			worker.current.onmessage = ({ data }: MessageEvent<SpeechResponse>) => {
				if (data.type === "status") setStatus(data.message);
				else if (data.type === "error") { setError(data.message); setBusy(false); }
				else { setResult({ blob: data.audio, url: URL.createObjectURL(data.audio) }); setStatus(`Generated on your ${data.device === "webgpu" ? "GPU" : "CPU"}.`); setBusy(false); }
			};
			worker.current.onerror = () => { setError("The speech engine stopped. Try CPU mode or a shorter clip."); worker.current?.terminate(); worker.current = null; setBusy(false); };
		}
		worker.current.postMessage({ text, voice, device } satisfies SpeechRequest);
	}
	async function addToProject() {
		const project = editor.project.getActive();
		if (!result || !project) return;
		setSaving(true); setError("");
		try {
			const assets = await processMediaAssets({ files: [new File([result.blob], `Voiceover-${Date.now()}.wav`, { type: "audio/wav" })] });
			if (editor.project.getActive()?.metadata.id !== project.metadata.id) throw new Error("The active project changed. Open the intended project and try again.");
			if (assets.length !== 1) throw new Error("Could not import generated audio.");
			editor.command.execute({ command: new AddMediaAssetCommand({ projectId: project.metadata.id, asset: assets[0] }) });
			setStatus("Voiceover added to project media.");
		} catch (error) { setError(error instanceof Error ? error.message : "Could not add voiceover"); }
		finally { setSaving(false); }
	}
	return <div className="space-y-4 overflow-y-auto p-4">
		<div><h3 className="font-medium">Create a voiceover</h3><p className="mt-1 text-xs text-muted-foreground">English · Kokoro 82M. Runs on this device. The first use downloads model files (about 90 MB for CPU or 330 MB for GPU), then reuses the browser cache.</p></div>
		<label className="block space-y-1 text-sm"><span>Text ({text.length}/250)</span><textarea value={text} maxLength={250} disabled={busy} onChange={(event) => setText(event.target.value)} className="min-h-28 w-full rounded border bg-background p-2" /></label>
		<label className="block space-y-1 text-sm"><span>Voice</span><select value={voice} disabled={busy} onChange={(event) => setVoice(event.target.value as SpeechRequest["voice"])} className="w-full rounded border bg-background p-2"><option value="af_heart">Heart · US English</option><option value="am_michael">Michael · US English</option><option value="bf_emma">Emma · UK English</option><option value="bm_george">George · UK English</option></select></label>
		<label className="block space-y-1 text-sm"><span>Processor</span><select value={device} disabled={busy} onChange={(event) => { worker.current?.terminate(); worker.current = null; setDevice(event.target.value as SpeechRequest["device"]); }} className="w-full rounded border bg-background p-2"><option value="auto">GPU when supported, otherwise CPU</option><option value="wasm">CPU (compatible mode)</option></select></label>
		{busy ? <Button variant="outline" onClick={cancel}>Cancel</Button> : <Button disabled={!text.trim() || saving} onClick={generate}>Generate voiceover</Button>}
		{status && <p role="status" className="text-xs">{status}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
		{result && <div className="space-y-3"><audio controls src={result.url} className="w-full" /><Button disabled={saving} onClick={() => void addToProject()}>{saving ? "Adding…" : "Add to project media"}</Button><a href={result.url} download="voiceover.wav" className="ml-3 text-sm underline">Download WAV</a></div>}
	</div>;
}
