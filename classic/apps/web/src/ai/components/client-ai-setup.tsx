"use client";
import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { aiClientFetch, prepareClientAiPairing } from "@/ai/client-transport";

export function ClientAiSetup() {
	const [open, setOpen] = useState(false),
		[error, setError] = useState("");
	const [ready, setReady] = useState(false),
		[busy, setBusy] = useState(false);
	const [authorizationUrl, setAuthorizationUrl] = useState("");
	useEffect(() => {
		const show = () => setOpen(true);
		window.addEventListener("opencut-ai-connect", show);
		return () => window.removeEventListener("opencut-ai-connect", show);
	}, []);
	useEffect(() => {
		if (!open || !ready) return;
		let cancelled = false;
		const timer = window.setInterval(() => {
			void aiClientFetch("/api/ai/oauth/status")
				.then((r) => r.json())
				.then((status) => {
					if (!cancelled && status.authenticated) {
						window.dispatchEvent(new Event("opencut-ai-connected"));
						setOpen(false);
					}
				})
				.catch(() => {});
		}, 2500);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [open, ready]);
	function downloadPairing() {
		const pair = prepareClientAiPairing();
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(pair, null, 2)], { type: "application/json" }),
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = "OpenCut-AI-Pairing.json";
		a.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function connect() {
		setError("");
		setBusy(true);
		try {
			const r = await aiClientFetch("/api/ai/oauth/status");
			const status = await r.json();
			if (!r.ok) throw Error(status.error || "Could not connect this account");
			setReady(true);
			if (status.authenticated) {
				window.dispatchEvent(new Event("opencut-ai-connected"));
				setOpen(false);
				return;
			}
			const started = await aiClientFetch("/api/ai/oauth/start", {
				method: "POST",
			});
			const login = await started.json();
			if (!started.ok)
				throw Error(login.error || "Could not start OpenAI sign-in");
			const url = new URL(login.authorizationUrl);
			if (url.origin !== "https://auth.openai.com")
				throw Error("Unexpected OpenAI sign-in address");
			setAuthorizationUrl(url.toString());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not connect");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="p-6">
				<DialogHeader>
					<DialogTitle>OpenAI on your device</DialogTitle>
					<DialogDescription>
						Connect your own OpenAI account. Your login and AI requests stay on
						this computer and go directly to OpenAI. They do not pass through
						the OpenCut hosting server.
					</DialogDescription>
				</DialogHeader>
				<ol className="list-decimal space-y-3 pl-5 text-sm">
					<li>
						<a
							className="underline"
							href="/downloads/OpenCut-AI-Windows.zip"
							download
						>
							Download OpenCut AI for Windows
						</a>{" "}
						and extract it.
					</li>
					<li>
						<button
							type="button"
							className="underline"
							onClick={downloadPairing}
						>
							Download this account’s pairing file
						</button>
						. Place it next to OpenCut-AI.exe.
					</li>
					<li>
						Open Start-OpenCut-AI.cmd, keep it running, then connect below.
						Allow local-network access if your browser asks.
					</li>
				</ol>
				<p className="text-xs text-muted-foreground">
					The pairing file grants this browser access to your local AI session.
					Keep it private. Each account and device needs its own pairing. No
					OpenAI password is stored in this file.
				</p>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<Button onClick={connect} disabled={busy}>
					{busy ? "Connecting…" : "Connect this device"}
				</Button>
				{authorizationUrl && (
					<a
						className="text-center underline"
						href={authorizationUrl}
						target="_blank"
						rel="noreferrer"
					>
						Continue to OpenAI sign-in
					</a>
				)}
			</DialogContent>
		</Dialog>
	);
}
