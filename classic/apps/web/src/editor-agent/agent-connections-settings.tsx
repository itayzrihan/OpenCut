"use client";
import { useEffect, useRef, useState } from "react";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { Button } from "@/components/ui/button";
import { Message } from "@/i18n/message";
import {
	prepareClientAiPairing,
	selectLocalProvider,
	readLocalProvider,
} from "@/ai/local-connection";
import { AgentSettingsSection } from "./settings-section";
import { HostedConnectionSettings } from "./hosted-connection-settings";
import {
	connectionRequest,
	connectionSchemas,
	type AgentConnection,
} from "./client";

type RevealProvider = "openai" | "openrouter" | "claude";
export function AgentConnectionsSettings({
	connection,
	refresh,
	stop,
	revealRequest = 0,
	revealProvider = "openai",
}: {
	connection: AgentConnection | null;
	refresh: () => Promise<void>;
	stop: () => void;
	revealRequest?: number;
	revealProvider?: RevealProvider;
}) {
	const hosted = isHostedBrowserWorkspace();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState(false);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	useEffect(() => {
		if (!waiting || connection?.sharing) return;
		const started = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - started > 180_000) {
				setWaiting(false);
				return;
			}
			void refresh().catch(() => {});
		}, 2000);
		return () => clearInterval(timer);
	}, [waiting, refresh, connection?.sharing]);

	const downloadPairing = () => {
		const pair = prepareClientAiPairing();
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(pair, null, 2)], { type: "application/json" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "POCUT-AI-Pairing.json";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	async function connect({
		provider,
		legacySignIn = false,
	}: {
		provider: "codex" | "claude" | null;
		legacySignIn?: boolean;
	}) {
		if (operation.current) return;
		const loginMayOpen = provider === "codex" || legacySignIn;
		const desktop = window.opencutElectron;
		const popup =
			loginMayOpen && !desktop?.openChatGPTSignIn
				? window.open("about:blank", "_blank", "popup,width=620,height=760")
				: null;
		if (popup) popup.opener = null;
		let navigating = false;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError("");
		stop();
		try {
			if (!provider) selectLocalProvider(null);
			if (provider || legacySignIn) {
				const state = await connectionRequest({
					schema: connectionSchemas.status,
					signal: controller.signal,
					providerOverride: provider,
				});
				if (provider && !state.installed)
					throw new Error(
						state.error ??
							"Install the official provider CLI before connecting",
					);
				if (provider) selectLocalProvider(provider);
				if (
					(legacySignIn || (provider === "codex" && state.installed)) &&
					!state.sharing
				) {
					if (!popup && !desktop?.openChatGPTSignIn)
						throw new Error(
							"Allow popups for POCUT, then reconnect with ChatGPT.",
						);
					const login = await connectionRequest({
						operation: "signIn",
						schema: connectionSchemas.signIn,
						signal: controller.signal,
					});
					if (desktop?.openChatGPTSignIn)
						await desktop.openChatGPTSignIn(login.authorizationUrl);
					else if (popup) popup.location.href = login.authorizationUrl;
					navigating = true;
					setWaiting(true);
				} else if (!state.sharing)
					setError(
						state.error ??
							"Complete the local provider sign-in, then check the connection again.",
					);
			}
			await refresh();
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : "Connection failed");
		} finally {
			if (!navigating) popup?.close();
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	async function disconnect() {
		if (operation.current) return;
		stop();
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		try {
			await connectionRequest({
				operation: "disconnect",
				signal: controller.signal,
				schema: connectionSchemas.disconnect,
			});
			setWaiting(false);
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not disconnect");
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	const local = readLocalProvider();
	const setup = (
		<div className="space-y-2 text-xs text-muted-foreground">
			<p>
				<Message text="The local companion keeps provider sign-in on your computer. One connection serves the Agent, AI tools and Director in this POCUT account." />
			</p>
			<ol className="list-decimal space-y-2 pl-5">
				<li>
					<a
						className="underline"
						href="/downloads/pocut-companion-v1.mjs"
						download="pocut-companion.mjs"
					>
						<Message text="Download the local companion" />
					</a>
					<span> · </span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={downloadPairing}
					>
						<Message text="Download pairing file" />
					</Button>
				</li>
				<li>
					<Message text="Install Node.js 22 or later and the provider's official CLI, then run the companion with your pairing file." />
					<pre className="overflow-x-auto whitespace-pre-wrap rounded border p-2">
						node pocut-companion.mjs POCUT-AI-Pairing.json
					</pre>
				</li>
				<li>
					<Message text="Return here, select the provider and complete its official sign-in. Use the same workspace tab that created the pairing file." />
				</li>
			</ol>
			<p>
				<Message text="Keep the companion running and allow local-network access if your browser asks. Credentials are never sent to the POCUT server." />
			</p>
		</div>
	);
	return (
		<>
			<AgentSettingsSection
				title="OpenAI / Codex"
				revealRequest={revealProvider === "openai" ? revealRequest : 0}
			>
				{!hosted && (
					<div className="space-y-2">
						<Button
							disabled={busy}
							onClick={() =>
								void connect({ provider: null, legacySignIn: true })
							}
						>
							<Message text="Connect ChatGPT directly on this device" />
						</Button>
						<p className="text-xs text-muted-foreground">
							<Message text="The direct local sign-in supports text and image input. Native Codex is required for image generation." />
						</p>
					</div>
				)}
				{setup}
				<p className="text-xs text-muted-foreground">
					<Message text="Continue with ChatGPT in the local Codex profile. Available models and image support depend on your account, CLI version and usage limits." />
				</p>
				<a
					className="text-xs underline"
					href="https://learn.chatgpt.com/docs/quickstart"
					target="_blank"
					rel="noreferrer"
				>
					<Message text="Install Codex CLI" />
				</a>
				<Button
					disabled={busy}
					onClick={() => void connect({ provider: "codex" })}
				>
					<Message
						text={
							connection?.provider === "local-codex" && connection.sharing
								? "Check Codex connection"
								: "Continue with ChatGPT"
						}
					/>
				</Button>
				{connection?.provider === "local-codex" && connection.sharing && (
					<p role="status" className="text-xs">
						<Message
							text={
								connection.imageGenerationSupported
									? "Codex connected · image generation supported; each image requires confirmation"
									: "Codex connected · image generation is unavailable in this connection"
							}
						/>
					</p>
				)}
			</AgentSettingsSection>
			<AgentSettingsSection
				title="OpenRouter"
				revealRequest={revealProvider === "openrouter" ? revealRequest : 0}
			>
				{!hosted ? (
					<p className="text-xs text-muted-foreground">
						<Message text="OpenRouter workspace connections are available on the hosted POCUT site." />
					</p>
				) : local ? (
					<Button
						disabled={busy}
						onClick={() => void connect({ provider: null })}
					>
						<Message text="Use OpenRouter for this workspace" />
					</Button>
				) : (
					<HostedConnectionSettings
						connection={connection}
						refresh={refresh}
						stop={stop}
					/>
				)}
			</AgentSettingsSection>
			<AgentSettingsSection
				title="Claude"
				revealRequest={revealProvider === "claude" ? revealRequest : 0}
			>
				{setup}
				<p className="text-xs text-muted-foreground">
					<Message text="Sign in directly with the unmodified Claude CLI in this companion profile. POCUT does not collect Claude credentials. Your provider's billing and usage limits apply." />
				</p>
				<a
					className="text-xs underline"
					href="https://code.claude.com/docs/en/quickstart"
					target="_blank"
					rel="noreferrer"
				>
					<Message text="Install Claude Code CLI" />
				</a>
				<pre className="overflow-x-auto whitespace-pre-wrap rounded border p-2">
					node pocut-companion.mjs POCUT-AI-Pairing.json --login-claude
				</pre>
				<Button
					disabled={busy}
					onClick={() => void connect({ provider: "claude" })}
				>
					<Message text="Check Claude connection" />
				</Button>
				<p className="text-xs text-muted-foreground">
					<Message text="Claude can propose editor actions and scene plans. Image generation is not supported by this connection." />
				</p>
			</AgentSettingsSection>
			{local && (
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void connect({ provider: null })}
				>
					<Message text="Use the workspace provider instead" />
				</Button>
			)}
			{local && (
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void disconnect()}
				>
					<Message text="Disconnect local provider" />
				</Button>
			)}
			{waiting && !connection?.sharing && (
				<p role="status" className="text-xs">
					<Message text="Complete the provider sign-in in the opened tab. This workspace will update automatically." />
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</>
	);
}
