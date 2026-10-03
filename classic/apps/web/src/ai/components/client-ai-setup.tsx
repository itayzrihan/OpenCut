"use client";
import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { aiClientFetch } from "@/ai/client-transport";

interface Login {
	verificationUrl: string;
	userCode: string;
	expiresAt: number;
}
export function ClientAiSetup() {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [login, setLogin] = useState<Login | null>(null);
	const generation = useRef(0);
	const account = useRef<string | null>(null);
	async function operation(action: string) {
		const response = await aiClientFetch("/api/ai/oauth/device", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
		const result = await response.json();
		if (!response.ok) throw Error(result.error || "OpenAI sign-in failed");
		return result;
	}
	useEffect(() => {
		const show = () => {
			account.current = window.__opencutAccountId;
			setOpen(true);
			setError("");
		};
		window.addEventListener("opencut-ai-connect", show);
		return () => {
			generation.current++;
			window.removeEventListener("opencut-ai-connect", show);
		};
	}, []);
	useEffect(() => {
		if (!open || !login) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			if (cancelled || account.current !== window.__opencutAccountId) return;
			try {
				if (Date.now() >= login!.expiresAt)
					throw Error("This code expired. Start sign-in again.");
				const result = await operation("poll");
				if (cancelled) return;
				if (result.authenticated) {
					setLogin(null);
					setOpen(false);
					window.dispatchEvent(new Event("opencut-ai-connected"));
					return;
				}
				timer = setTimeout(poll, 2500);
			} catch (e) {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "Sign-in failed");
					setLogin(null);
				}
			}
		}
		timer = setTimeout(poll, 2500);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, login]);
	function changeOpen(value: boolean) {
		setOpen(value);
		if (!value) {
			generation.current++;
			setLogin(null);
			setBusy(false);
			if (account.current === window.__opencutAccountId)
				void operation("cancel").catch(() => {});
		}
	}
	async function connect() {
		const current = ++generation.current;
		setBusy(true);
		setError("");
		try {
			const result = await operation("start");
			if (
				result.verificationUrl !== "https://auth.openai.com/codex/device" ||
				typeof result.userCode !== "string"
			)
				throw Error("Unexpected OpenAI sign-in response");
			if (current === generation.current) setLogin(result);
		} catch (e) {
			if (current === generation.current)
				setError(e instanceof Error ? e.message : "Could not start sign-in");
		} finally {
			if (current === generation.current) setBusy(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="p-6">
				<DialogHeader>
					<DialogTitle>Connect your OpenAI account</DialogTitle>
					<DialogDescription>
						Sign in through OpenAI in your browser. No download is needed.
						OpenCut stores access credentials encrypted on this server,
						separately for your OpenCut account and this session.
					</DialogDescription>
				</DialogHeader>
				{login ? (
					<div className="space-y-4 text-sm">
						<p>Enter this one-time code on OpenAI’s website:</p>
						<p
							className="select-all rounded border p-4 text-center font-mono text-2xl tracking-widest"
							aria-label="OpenAI sign-in code"
						>
							{login.userCode}
						</p>
						<Button asChild className="w-full">
							<a href={login.verificationUrl} target="_blank" rel="noreferrer">
								Continue to OpenAI
							</a>
						</Button>
						<p role="status">
							Waiting for approval… Return here after signing in.
						</p>
						<p className="text-muted-foreground">
							If OpenAI asks, enable device-code login in ChatGPT Settings →
							Security. Keep this code private.
						</p>
						<Button variant="outline" onClick={() => changeOpen(false)}>
							Cancel sign-in
						</Button>
					</div>
				) : (
					<Button onClick={connect} disabled={busy}>
						{busy ? "Preparing sign-in…" : "Sign in with OpenAI"}
					</Button>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
