"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Message as UiMessage } from "@/i18n/message";
import {
	connectionRequest,
	connectionSchemas,
	type AgentConnection,
} from "./client";

export function HostedConnectionSettings({
	connection,
	refresh,
	stop,
}: {
	connection: AgentConnection | null;
	refresh: () => Promise<void>;
	stop: () => void;
}) {
	const formId = useId();
	const [key, setKey] = useState("");
	const [pin, setPin] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	async function update(disconnect: boolean) {
		if (operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError("");
		stop();
		try {
			if (disconnect)
				await connectionRequest({
					operation: "disconnect",
					signal: controller.signal,
					schema: connectionSchemas.disconnect,
				});
			else
				await connectionRequest({
					operation: "connectHosted",
					input: {
						pin,
						...(!connection?.connected ? { apiKey: key } : {}),
						confirmed: true,
					},
					signal: controller.signal,
					schema: connectionSchemas.status,
				});
			setKey("");
			setPin("");
			setConfirmed(false);
			await refresh();
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(
					cause instanceof Error
						? cause.message
						: "Provider connection failed.",
				);
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<div className="space-y-3 rounded-lg border p-3 text-sm">
			<h3 className="font-medium">OpenRouter</h3>
			<p className="text-muted-foreground">
				<UiMessage text="Connect your own OpenRouter account for browser AI editing. Your API key stays encrypted in your account's PIN vault, shared with Generative." />
			</p>
			{connection?.sharing ? (
				<>
					<p role="status">
						<UiMessage text="Agent connected" /> ·{" "}
						{connection.remainingRequests ?? 0} requests left ·{" "}
						{Math.ceil((connection.sessionSeconds ?? 0) / 60)} min
					</p>
					<Button
						disabled={busy}
						variant="outline"
						onClick={() => void update(true)}
					>
						<UiMessage text="Lock provider" />
					</Button>
				</>
			) : (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (confirmed && !busy) void update(false);
					}}
				>
					{!connection?.connected && (
						<label className="block space-y-1" htmlFor={`${formId}-key`}>
							<span>OpenRouter API key</span>
							<Input
								id={`${formId}-key`}
								type="password"
								autoComplete="off"
								value={key}
								maxLength={1024}
								onChange={(event) => setKey(event.target.value)}
								required
							/>
						</label>
					)}
					<label className="block space-y-1" htmlFor={`${formId}-pin`}>
						<span>
							<UiMessage
								text={
									connection?.connected
										? "Vault PIN"
										: "Create a PIN (6–16 digits)"
								}
							/>
						</span>
						<Input
							id={`${formId}-pin`}
							type="password"
							inputMode="numeric"
							autoComplete="off"
							pattern="[0-9]{6,16}"
							minLength={6}
							maxLength={16}
							value={pin}
							onChange={(event) => setPin(event.target.value)}
							required
						/>
					</label>
					<label className="flex items-start gap-2">
						<input
							className="mt-1"
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						<span>
							<UiMessage text="I authorize paid AI editing requests for 15 minutes, up to 40 requests. OpenRouter charges my account at the selected model's rates. Video and image generation still require separate approval and my PIN." />
						</span>
					</label>
					<Button
						type="submit"
						disabled={
							busy ||
							!confirmed ||
							!/^\d{6,16}$/.test(pin) ||
							(!connection?.connected && !key.trim())
						}
					>
						<UiMessage text={busy ? "Connecting…" : "Unlock Agent"} />
					</Button>
				</form>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			<p className="flex gap-3">
				<a
					href="https://openrouter.ai/settings/keys"
					target="_blank"
					rel="noreferrer"
					className="underline"
				>
					<UiMessage text="API keys" />
				</a>
				<a
					href="https://openrouter.ai/models"
					target="_blank"
					rel="noreferrer"
					className="underline"
				>
					<UiMessage text="Model prices" />
				</a>
				<a
					href="https://openrouter.ai/activity"
					target="_blank"
					rel="noreferrer"
					className="underline"
				>
					<UiMessage text="Usage" />
				</a>
			</p>
			<p className="text-xs text-muted-foreground">
				<UiMessage text="Media processing and local AI models run in your browser. Prompts and selected review images go to your connected provider. ChatGPT subscription sign-in is available through the local Codex companion on this device." />
			</p>
		</div>
	);
}
