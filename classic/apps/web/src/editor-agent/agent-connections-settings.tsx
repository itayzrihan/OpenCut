"use client";
import { useEffect, useRef, useState } from "react";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { Button } from "@/components/ui/button";
import { Message } from "@/i18n/message";
import {
	completeClientAiSetup,
	prepareClientAiSetup,
	selectLocalProvider,
	readLocalProvider,
} from "@/ai/local-connection";
import {
	createPairingPackage,
	PAIRING_PACKAGE_NAME,
} from "@/ai/pairing-package";
import { downloadBlob } from "@/utils/browser";
import { SettingsInfo } from "./settings-info";
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
	const [waiting, setWaiting] = useState<"codex" | "claude" | null>(null);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	useEffect(() => {
		if (!waiting || connection?.sharing) return;
		const started = Date.now();
		const timer = setInterval(() => {
			if (Date.now() - started > 180_000) {
				setWaiting(null);
				return;
			}
			void refresh().catch(() => {});
		}, 2000);
		return () => clearInterval(timer);
	}, [waiting, refresh, connection?.sharing]);

	async function downloadPairing() {
		if (operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError("");
		try {
			const account = window.__opencutAccountId;
			const setup = prepareClientAiSetup();
			const blob = await createPairingPackage({
				setup,
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			if (window.__opencutAccountId !== account)
				throw new Error("Account changed. Download fresh instructions.");
			downloadBlob({ blob, filename: PAIRING_PACKAGE_NAME });
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(
					cause instanceof Error
						? cause.message
						: "Could not download pairing instructions",
				);
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
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
				const check = () =>
					connectionRequest({
						schema: connectionSchemas.status,
						signal: controller.signal,
						providerOverride: provider,
					});
				const state = await check().catch(async (cause) => {
					controller.signal.throwIfAborted();
					if (
						!provider ||
						!(await completeClientAiSetup({ signal: controller.signal }))
					)
						throw cause;
					return check();
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
					setWaiting("codex");
				} else if (provider === "claude" && !state.sharing)
					setWaiting("claude");
				else if (!state.sharing)
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
			setWaiting(null);
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
		<SettingsInfo label="Setup instructions">
			<p className="text-xs text-muted-foreground">
				<Message text="Download the pairing instructions and bring it to your AI assistant." />
			</p>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() => void downloadPairing()}
			>
				<Message text="Download the pairing instructions" />
			</Button>
		</SettingsInfo>
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
					<Message
						text={
							waiting === "claude"
								? "Complete Claude sign-in with your AI assistant. This workspace will update automatically."
								: "Complete the provider sign-in in the opened tab. This workspace will update automatically."
						}
					/>
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
