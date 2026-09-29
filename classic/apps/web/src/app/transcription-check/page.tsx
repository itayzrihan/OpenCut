"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { transcribeTimelineAudioBlob } from "@/transcription/browser-client";
import type { TranscriptionResult } from "@/transcription/types";

export default function TranscriptionCheck() {
	const controller = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("Ready to test this browser.");
	const [result, setResult] = useState<TranscriptionResult | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	async function run(file?: File) {
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		setResult(null);
		setStatus("Preparing local audio…");
		try {
			const audioBlob =
				file ??
				(await fetch("/transcription-check.wav", { signal: abort.signal }).then(
					(r) => {
						if (!r.ok) throw new Error("Sample audio unavailable");
						return r.blob();
					},
				));
			if (!audioBlob) throw new Error("Audio unavailable");
			const value = await transcribeTimelineAudioBlob({
				audioBlob,
				language: file ? "he" : "en",
				signal: abort.signal,
				onProgress: (p) => setStatus(p.message || p.status),
			});
			setResult(value);
			setStatus(
				`Completed locally · ${value.words?.length ?? 0} timed words. No project was changed.`,
			);
		} catch (e) {
			setStatus(
				abort.signal.aborted
					? "Cancelled. Completed model downloads stay cached."
					: e instanceof Error
						? e.message
						: String(e),
			);
		} finally {
			controller.current = null;
			setBusy(false);
		}
	}
	return (
		<main className="mx-auto max-w-3xl space-y-6 p-8">
			<Link href="/projects" className="underline">
				Back to projects
			</Link>
			<h1 className="text-2xl font-semibold">Browser transcription check</h1>
			<p>
				ivrit-ai Large v3 Turbo downloads automatically and runs on this device.
				WebGPU uses your GPU when supported; on Mac, the browser manages Metal.
				Otherwise this uses the CPU locally, which is slower.
			</p>
			<p>
				The first run downloads approximately 1.6 GB. Public model weights are
				cached in this browser. Your audio and transcript are not uploaded or
				saved by this check.
			</p>
			<div className="flex flex-wrap gap-3">
				<Button disabled={busy} onClick={() => void run()}>
					Test with sample speech
				</Button>
				<Button
					variant="outline"
					disabled={!busy}
					onClick={() => controller.current?.abort()}
				>
					Cancel
				</Button>
			</div>
			<label className="block space-y-2">
				<span>Or test a Hebrew audio file from your device</span>
				<input
					className="block"
					type="file"
					accept="audio/*"
					disabled={busy}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void run(file);
						e.target.value = "";
					}}
				/>
			</label>
			<p role="status" className="break-words rounded border p-4">
				{status}
			</p>
			{result && (
				<>
					<p dir="auto" className="rounded border p-4">
						{result.text}
					</p>
					<table className="w-full text-sm">
						<thead>
							<tr>
								<th>Word</th>
								<th>Start (s)</th>
								<th>End (s)</th>
							</tr>
						</thead>
						<tbody>
							{result.words?.map((w, i) => (
								<tr key={i}>
									<td dir="auto">{w.text}</td>
									<td>{w.start.toFixed(2)}</td>
									<td>{w.end.toFixed(2)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</main>
	);
}
