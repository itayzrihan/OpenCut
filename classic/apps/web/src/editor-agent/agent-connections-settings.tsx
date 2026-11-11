"use client";
import { useEffect, useRef, useState } from "react";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { Check } from "lucide-react";
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
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
	refresh: (signal?: AbortSignal) => Promise<void>;
	stop: () => void;
	revealRequest?: number;
	revealProvider?: RevealProvider;
}) {
	const hosted = isHostedBrowserWorkspace();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [waiting, setWaiting] = useState<"codex" | "claude" | null>(null);
	const [login, setLogin] = useState<{
		url: string;
		expiresAt: number;
		account: string | null | undefined;
	} | null>(null);
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
		const desktop = window.opencutElectron;
		const account = window.__opencutAccountId;
		setLogin(null);
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
					const login = await connectionRequest({
						operation: "signIn",
						schema: connectionSchemas.signIn,
						signal: controller.signal,
					});
					if (desktop?.openChatGPTSignIn) {
						await desktop.openChatGPTSignIn(login.authorizationUrl);
						setWaiting("codex");
					} else {
						setLogin({
							url: login.authorizationUrl,
							expiresAt: login.expiresAt,
							account,
						});
					}
				} else if (provider === "claude" && !state.sharing)
					setWaiting("claude");
				else if (!state.sharing)
					setError(
						state.error ??
							"Complete the local provider sign-in, then check the connection again.",
					);
			}
			await refresh(controller.signal);
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : "Connection failed");
		} finally {
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
			await refresh(controller.signal);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not disconnect");
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	async function checkConnection() {
		if (operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError("");
		try {
			await refresh(controller.signal);
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : "Connection failed");
		} finally {
			operation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	function providerAction(provider: "codex" | "claude") {
		const connected =
			connection?.provider === `local-${provider}` && connection.sharing;
		return (
			<div className="flex flex-col items-center gap-1 text-center">
				{connected ? (
					<>
						<span
							role="status"
							className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300"
						>
							<Check size={15} aria-hidden="true" />
							<Message
								text={
									provider === "codex"
										? "Codex is connected"
										: "Claude is connected"
								}
							/>
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => void checkConnection()}
						>
							<Message text="Check Connection" />
						</Button>
					</>
				) : (
					<Button disabled={busy} onClick={() => void connect({ provider })}>
						<Message text="Connect" />
					</Button>
				)}
			</div>
		);
	}

	const local = readLocalProvider();
	const setup = (
		<div className="flex flex-col items-center gap-2 text-center">
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
				{providerAction("codex")}
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
				{providerAction("claude")}
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
			<Dialog
				open={login !== null}
				onOpenChange={(open) => {
					if (!open) setLogin(null);
				}}
			>
				{login && (
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								<Message text="Connect Codex" />
							</DialogTitle>
							<DialogDescription>
								<Message text="Sign in to ChatGPT to finish connecting Codex." />
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="items-center">
							<Button asChild>
								<a
									href={login.url}
									target="_blank"
									rel="noreferrer"
									onClick={(event) => {
										if (
											Date.now() >= login.expiresAt ||
											window.__opencutAccountId !== login.account
										) {
											event.preventDefault();
											setError("Click Connect to start a new sign-in.");
										} else setWaiting("codex");
										setLogin(null);
									}}
								>
									<Message text="Continue with ChatGPT" />
								</a>
							</Button>
						</DialogBody>
					</DialogContent>
				)}
			</Dialog>
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
