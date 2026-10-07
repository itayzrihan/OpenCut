"use client";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The conversation log is a focusable scroll region so keyboard users can review earlier messages. */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent,
	type ReactNode,
} from "react";
import {
	Bot,
	ArrowDown,
	Copy,
	BrainCircuit,
	Check,
	LoaderCircle,
	Command,
	GripHorizontal,
	Minus,
	PanelRight,
	Paperclip,
	Play,
	Square,
	X,
} from "lucide-react";
import { useEditor } from "@/editor/use-editor";
import { AgentMarkdown, messageDirection } from "./markdown";
import { KnowledgePanel } from "./knowledge-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
	EditingAgentSnapshot,
	EditingAgentProviderRound,
} from "@/core/agent-protocol";
import {
	connectionRequest,
	connectionSchemas,
	EditorAgentClient,
	type AgentClientEvent,
	type AgentConnection,
	type AgentModel,
} from "./client";
import styles from "./overlay.module.css";
import { z } from "zod";
import { EDITING_AGENT_DRAFT_EVENT } from "./draft";

interface Entry {
	interrupted?: boolean;
	attachments?: import("@/core/agent-protocol").EditingInputAttachment[];
	id: string;
	kind: "user" | "round" | "status";
	text: string;
	summary?: string;
	review?: boolean;
	activities?: EditingAgentProviderRound["activities"];
	images?: string[];
	issues?: string[];
	export?: { url: string; filename: string };
	exportUnavailable?: boolean;
}

/** Presentation state only. The editor document and agent run live in Rust. */
export function EditorAgentWorkspace({ children }: { children: ReactNode }) {
	const [mode, setMode] = useState<"floating" | "docked" | "minimized">(
		"floating",
	);
	if (process.env.NEXT_PUBLIC_EDITOR_AGENT === "0") return children;
	return (
		<div className={styles.workspace}>
			<div className={styles.editor}>{children}</div>
			<AgentPanel mode={mode} onMode={setMode} />
		</div>
	);
}

function AgentPanel({
	mode,
	onMode,
}: {
	mode: "floating" | "docked" | "minimized";
	onMode: (mode: "floating" | "docked" | "minimized") => void;
}) {
	const editor = useEditor();
	const client = useRef<EditorAgentClient | null>(null);
	const mounted = useRef(true);
	const [connection, setConnection] = useState<AgentConnection | null>(null);
	const [imageConnection, setImageConnection] = useState<
		boolean | "unavailable" | null
	>(null);
	const [models, setModels] = useState<AgentModel[]>([]);
	const [model, setModel] = useState("");
	const transient = useRef(
		new Map<
			string,
			{ images?: string[]; export?: { url: string; filename: string } }
		>(),
	);
	const projectEntries = useCallback(
		(
			items: import("@/core/agent-protocol").EditingConversationEntry[],
		): Entry[] =>
			items.map(({ export: savedExport, ...entry }) => ({
				...entry,
				...transient.current.get(entry.id),
				exportUnavailable:
					!!savedExport && !transient.current.get(entry.id)?.export,
			})),
		[],
	);
	const [entries, setEntries] = useState<Entry[]>(() =>
		(editor.command.getEditingConversation()?.entries ?? []).map(
			({ export: savedExport, ...entry }) => ({
				...entry,
				exportUnavailable: !!savedExport,
			}),
		),
	);
	const [snapshot, setSnapshot] = useState<EditingAgentSnapshot | null>(() =>
		editor.command.getEditingAgentSnapshot(),
	);
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<
		import("@/core/agent-protocol").EditingInputAttachment[]
	>([]);
	const attachmentInput = useRef<HTMLInputElement>(null);
	const composerInput = useRef<HTMLTextAreaElement>(null);
	const attachmentInFlight = useRef(false);
	const [attaching, setAttaching] = useState(false);
	const [dropActive, setDropActive] = useState(false);
	const [following, setFollowing] = useState(true);
	const attachFiles = async (files: FileList | null) => {
		if (!files?.length || attachmentInFlight.current || busy) return;
		attachmentInFlight.current = true;
		setAttaching(true);
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		const accountId = window.__opencutAccountId ?? "local";
		try {
			if (files.length + attachments.length > 8)
				throw new Error("Attach at most eight files");
			const selected: import("@/core/agent-protocol").EditingInputAttachment[] =
				[];
			for (const file of Array.from(files)) {
				if (file.size > 2_000_000)
					throw new Error("Attachment exceeds the two-megabyte request budget");
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (
					editor.project.getActiveOrNull()?.metadata.id !== projectId ||
					(window.__opencutAccountId ?? "local") !== accountId
				)
					throw new Error("Attachment account/project changed");
				const mimeType =
					file.type ||
					(file.name.toLowerCase().endsWith(".md")
						? "text/markdown"
						: file.name.toLowerCase().endsWith(".txt")
							? "text/plain"
							: "application/octet-stream");
				selected.push(
					editor.command.storeEditingAttachment({
						filename: file.name,
						bytes,
						mimeType,
					}),
				);
			}
			setAttachments((previous) => [...previous, ...selected]);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not attach files",
			);
		} finally {
			attachmentInFlight.current = false;
			if (mounted.current) setAttaching(false);
		}
	};
	const [busy, setBusy] = useState(false);
	const [knowledgeOpen, setKnowledgeOpen] = useState(false);
	const [error, setError] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [position, setPosition] = useState<{
		left: number;
		top: number;
	} | null>(null);
	const panel = useRef<HTMLElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useEffect(() => {
		const input = composerInput.current;
		if (!input) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(160, Math.max(66, input.scrollHeight))}px`;
	}, [draft, mode, knowledgeOpen]);
	const drag = useRef<{
		x: number;
		y: number;
		left: number;
		top: number;
	} | null>(null);
	const generation = useRef(0);
	const statusAbort = useRef<AbortController | null>(null);
	useEffect(() => {
		const urls: string[] = [];
		const cache = transient.current;
		let disposed = false;
		const archive = editor.command.getEditingConversation();
		const readUrl = ({ id, allowed }: { id: string; allowed: string[] }) => {
			try {
				const artifact = editor.command.readEditingConversationArtifact(id);
				if (!allowed.includes(artifact.mimeType)) return null;
				const url = URL.createObjectURL(
					new Blob([Uint8Array.from(artifact.bytes)], {
						type: artifact.mimeType,
					}),
				);
				urls.push(url);
				return url;
			} catch {
				return null;
			}
		};
		for (const entry of archive?.entries ?? []) {
			const images = (entry.artifactIds ?? [])
				.map((id) =>
					readUrl({ id, allowed: ["image/jpeg", "image/png", "image/webp"] }),
				)
				.filter((url): url is string => !!url);
			const video = entry.export
				? readUrl({
						id: entry.export.artifactId,
						allowed: ["video/webm", "video/mp4"],
					})
				: null;
			if (images.length || video)
				transient.current.set(entry.id, {
					...(images.length ? { images } : {}),
					...(video && entry.export
						? { export: { url: video, filename: entry.export.filename } }
						: {}),
				});
		}
		queueMicrotask(() => {
			if (!disposed) setEntries(projectEntries(archive?.entries ?? []));
		});
		return () => {
			disposed = true;
			for (const url of urls) URL.revokeObjectURL(url);
			cache.clear();
		};
	}, [editor, projectEntries]);
	useEffect(() => {
		const receiveDraft = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const parsed = z
				.object({
					projectId: z.string(),
					accountId: z.string(),
					text: z.string().min(1).max(12000),
				})
				.strict()
				.safeParse(event.detail);
			if (
				!parsed.success ||
				parsed.data.projectId !==
					editor.project.getActiveOrNull()?.metadata.id ||
				parsed.data.accountId !== (window.__opencutAccountId ?? "local")
			)
				return;
			setDraft((previous) =>
				previous.trim()
					? `${previous}\n\n${parsed.data.text}`
					: parsed.data.text,
			);
			onMode("floating");
		};
		window.addEventListener(EDITING_AGENT_DRAFT_EVENT, receiveDraft);
		return () =>
			window.removeEventListener(EDITING_AGENT_DRAFT_EVENT, receiveDraft);
	}, [editor, onMode]);
	const receive = useCallback(
		(event: AgentClientEvent) => {
			if (!mounted.current) return;
			if (event.type === "conversation") {
				setEntries(projectEntries(event.entries));
				return;
			}
			if (event.type === "snapshot") {
				setSnapshot(event.snapshot);
				return;
			}
			const archive = editor.command.getEditingConversation();
			if (event.type === "export") {
				const id = archive?.entries.at(-1)?.id;
				if (id)
					transient.current.set(id, {
						export: { url: event.url, filename: event.filename },
					});
			} else if (
				(event.type === "review" || event.type === "artifacts") &&
				archive?.activeRound
			) {
				transient.current.set(archive.activeRound, { images: event.images });
			} else return;
			setEntries(projectEntries(archive?.entries ?? []));
		},
		[editor, projectEntries],
	);

	const refresh = useCallback(async (signal?: AbortSignal) => {
		const accountId = window.__opencutAccountId ?? "local";
		const imageStatus = await fetch("/api/editor-agent/subscription-image", {
			credentials: "same-origin",
			cache: "no-store",
			signal,
			headers: { "X-OpenCut-Account": accountId },
		})
			.then((response) => response.json() as Promise<unknown>)
			.catch(() => undefined);
		if (accountId !== (window.__opencutAccountId ?? "local")) return;
		if (mounted.current && !signal?.aborted)
			setImageConnection(
				z.object({ authenticated: z.boolean() }).safeParse(imageStatus).data
					?.authenticated ?? "unavailable",
			);
		const status = await connectionRequest({
			signal,
			schema: connectionSchemas.status,
		});
		if (!mounted.current || signal?.aborted) return;
		setConnection(status);
		if (status.sharing) {
			const result = await connectionRequest({
				operation: "models",
				schema: connectionSchemas.models,
				signal,
			});
			if (!mounted.current || signal?.aborted) return;
			setModels(result.models);
			setModel((old) =>
				result.models.some((m) => m.id === old)
					? old
					: (result.models[0]?.id ?? ""),
			);
		}
	}, []);
	useEffect(() => {
		mounted.current = true;
		client.current = new EditorAgentClient({ editor, emit: receive });
		const controller = new AbortController();
		statusAbort.current = controller;
		void refresh(controller.signal).catch((cause) => {
			if (!controller.signal.aborted) setError(String(cause));
		});
		const pause = () => {
			try {
				client.current?.pause();
			} catch {
				/* Editor may already be detached. */
			}
		};
		window.addEventListener("pagehide", pause);
		return () => {
			mounted.current = false;
			generation.current += 1;
			controller.abort();
			statusAbort.current?.abort();
			client.current?.dispose();
			client.current = null;
			window.removeEventListener("pagehide", pause);
		};
	}, [editor, receive, refresh]);
	useEffect(() => {
		if (follow.current && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [entries, mode, snapshot]);
	useEffect(() => {
		const clamp = () =>
			setPosition((old) =>
				old
					? {
							left: Math.max(
								8,
								Math.min(
									old.left,
									window.innerWidth - Math.min(380, window.innerWidth - 16),
								),
							),
							top: Math.max(8, Math.min(old.top, window.innerHeight - 80)),
						}
					: null,
			);
		window.addEventListener("resize", clamp);
		return () => window.removeEventListener("resize", clamp);
	}, []);
	const signIn = async () => {
		// Open during the user gesture so the authorization window is not blocked.
		const popup = window.open(
			"about:blank",
			"_blank",
			"popup,width=620,height=760",
		);
		if (popup) popup.opener = null;
		setConnecting(true);
		setError("");
		const controller = new AbortController();
		statusAbort.current?.abort();
		statusAbort.current = controller;
		try {
			if (!popup)
				throw new Error(
					"Allow popups for OpenCut, then reconnect with ChatGPT.",
				);
			const result = await connectionRequest({
				operation: "signIn",
				signal: controller.signal,
				schema: connectionSchemas.signIn,
			});
			popup.location.href = result.authorizationUrl;
			while (Date.now() < result.expiresAt && !controller.signal.aborted) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, 1800);
					function done() {
						clearTimeout(timer);
						controller.signal.removeEventListener("abort", done);
						resolve();
					}
					controller.signal.addEventListener("abort", done, { once: true });
				});
				controller.signal.throwIfAborted();
				const status = await connectionRequest({
					signal: controller.signal,
					schema: connectionSchemas.status,
				});
				if (!status.connecting) {
					await refresh(controller.signal);
					if (status.error) setError(status.error);
					break;
				}
			}
		} catch (cause) {
			popup?.close();
			if (!controller.signal.aborted)
				setError(
					cause instanceof Error ? cause.message : "ChatGPT sign-in failed",
				);
		} finally {
			if (mounted.current) setConnecting(false);
		}
	};
	const send = async (resume = false) => {
		const text = resume ? undefined : draft.trim();
		if (
			(!text && !resume) ||
			!client.current ||
			!model ||
			attachmentInFlight.current
		)
			return;
		const attempt = ++generation.current;
		setDraft("");
		setError("");
		setBusy(true);
		follow.current = true;
		setFollowing(true);
		try {
			const selected = attachments.length ? attachments : undefined;
			setAttachments([]);
			await client.current.run({ text, model, attachments: selected });
		} catch (cause) {
			if (mounted.current && generation.current === attempt)
				setError(cause instanceof Error ? cause.message : "Editing run failed");
		} finally {
			if (mounted.current && generation.current === attempt) setBusy(false);
		}
	};
	const stop = () => {
		generation.current += 1;
		client.current?.pause();
		setBusy(false);
	};
	const moveStart = (event: PointerEvent<HTMLElement>) => {
		if (
			mode !== "floating" ||
			event.button !== 0 ||
			(event.target instanceof Element && event.target.closest("button"))
		)
			return;
		const bounds = panel.current?.getBoundingClientRect();
		if (!bounds) return;
		drag.current = {
			x: event.clientX,
			y: event.clientY,
			left: bounds.left,
			top: bounds.top,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		if (!drag.current) return;
		const bounds = panel.current?.getBoundingClientRect();
		setPosition({
			left: Math.max(
				8,
				Math.min(
					window.innerWidth - (bounds?.width ?? 380) - 8,
					drag.current.left + event.clientX - drag.current.x,
				),
			),
			top: Math.max(
				8,
				Math.min(
					window.innerHeight - (bounds?.height ?? 500) - 8,
					drag.current.top + event.clientY - drag.current.y,
				),
			),
		});
	};
	return (
		<>
			{mode === "minimized" && (
				<Button className={styles.launcher} onClick={() => onMode("floating")}>
					<Bot /> {busy ? "Agent is editing…" : "OpenCut Agent"}
				</Button>
			)}
			<aside
				ref={panel}
				aria-label="OpenCut editing agent"
				data-testid="editor-agent"
				className={`${styles.panel} ${mode === "docked" ? styles.docked : styles.floating}`}
				hidden={mode === "minimized"}
				style={
					mode === "floating" && position
						? {
								left: position.left,
								top: position.top,
								right: "auto",
								bottom: "auto",
							}
						: undefined
				}
			>
				<header
					className={styles.header}
					onPointerDown={moveStart}
					onPointerMove={move}
					onPointerUp={() => {
						drag.current = null;
					}}
					onPointerCancel={() => {
						drag.current = null;
					}}
				>
					<Bot size={17} />
					<strong>OpenCut Agent</strong>
					<Button
						variant="ghost"
						size="sm"
						aria-pressed={knowledgeOpen}
						onClick={() => setKnowledgeOpen(!knowledgeOpen)}
					>
						{knowledgeOpen ? "Chat" : "Knowledge"}
					</Button>
					<span className={styles.badge}>Preview</span>
					<Button
						variant="ghost"
						size="icon"
						title={mode === "docked" ? "Float chat" : "Dock chat"}
						aria-label={mode === "docked" ? "Float chat" : "Dock chat"}
						onClick={() => onMode(mode === "docked" ? "floating" : "docked")}
					>
						<PanelRight />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Minimize chat"
						onClick={() => onMode("minimized")}
					>
						<Minus />
					</Button>
				</header>
				<div className={styles.connection}>
					{connection?.sharing ? (
						<>
							<span title={connection.identity?.email}>
								{connection.identity?.name ??
									connection.identity?.email ??
									"ChatGPT connected"}
							</span>
							<Button
								variant="text"
								size="sm"
								onClick={() => {
									stop();
									void connectionRequest({
										operation: "disconnect",
										schema: connectionSchemas.disconnect,
									})
										.then(() => refresh())
										.catch((e) => setError(String(e)));
								}}
							>
								Disconnect
							</Button>
						</>
					) : (
						<>
							<span>
								{connection?.connected
									? "Enable ChatGPT plan usage"
									: "Connect your ChatGPT account"}
							</span>
							<Button
								size="sm"
								disabled={connecting}
								onClick={() => void signIn()}
							>
								{connecting ? "Connecting…" : "Connect"}
							</Button>
						</>
					)}
				</div>
				<div className={styles.connection}>
					<span>
						{imageConnection === null
							? "Checking image subscription…"
							: imageConnection === "unavailable"
								? "Image connection unavailable · retry"
								: imageConnection
									? "Codex images connected · image access unverified"
									: "Codex images require a separate subscription connection"}
					</span>
					<a
						href={`/api/ai/oauth/start?returnTo=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}`}
						target="_blank"
						rel="noreferrer"
					>
						{imageConnection === true ? "Reconnect images" : "Connect images"}
					</a>
					<button
						type="button"
						onClick={() =>
							void refresh().catch((cause) => setError(String(cause)))
						}
					>
						Refresh
					</button>
				</div>
				{knowledgeOpen && (
					<KnowledgePanel projectId={editor.project.getActive().metadata.id} />
				)}
				<div
					ref={scroll}
					hidden={knowledgeOpen}
					className={styles.messages}
					role="log"
					aria-label="Editing conversation"
					aria-live="polite"
					aria-busy={busy}
					tabIndex={0}
					onScroll={(event) => {
						const node = event.currentTarget;
						follow.current =
							node.scrollHeight - node.scrollTop - node.clientHeight < 80;
						setFollowing(follow.current);
					}}
				>
					{entries.length === 0 && (
						<div className={styles.empty}>
							<Bot size={28} />
							<h2>What should change in your video?</h2>
							<p>
								Describe the edit. Follow the plan, inspect each action, and
								refine the result as we work.
							</p>
						</div>
					)}
					{entries.map((entry) => (
						<EntryView key={entry.id} entry={entry} />
					))}
					{snapshot?.plan.length ? (
						<details className={styles.plan} open>
							<summary>Editing plan</summary>
							<ol>
								{snapshot.plan.map((step, index) => (
									<li key={`${index}-${step.title}`} data-status={step.status}>
										{step.status === "complete" ? (
											<Check size={12} />
										) : (
											<span>{index + 1}</span>
										)}
										<span dir="auto">{step.title}</span>
									</li>
								))}
							</ol>
						</details>
					) : null}
				</div>
				{!following && !knowledgeOpen && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className={styles.followLatest}
						onClick={() => {
							follow.current = true;
							setFollowing(true);
							scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
						}}
					>
						<ArrowDown size={12} /> Latest messages
					</Button>
				)}
				{(error || connection?.error) && (
					<div className={styles.error} role="alert">
						<span>{error || connection?.error}</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Dismiss error"
							onClick={() => {
								setError("");
								setConnection((old) => (old ? { ...old, error: null } : old));
							}}
						>
							<X />
						</Button>
					</div>
				)}
				<form
					hidden={knowledgeOpen}
					className={`${styles.composer} ${dropActive ? styles.dropActive : ""}`}
					aria-label="Chat message composer"
					onDragOver={(event) => {
						if (event.dataTransfer.types.includes("Files")) {
							event.preventDefault();
							if (!busy && !attaching) setDropActive(true);
						}
					}}
					onDragLeave={(event) => {
						if (
							!(event.relatedTarget instanceof Node) ||
							!event.currentTarget.contains(event.relatedTarget)
						)
							setDropActive(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setDropActive(false);
						void attachFiles(event.dataTransfer.files);
					}}
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<Textarea
						ref={composerInput}
						dir={messageDirection(draft)}
						aria-label="Message the editing agent"
						placeholder={
							busy
								? "Add a correction or change direction…"
								: "Describe your edit…"
						}
						value={draft}
						maxLength={100000}
						onChange={(event) => setDraft(event.target.value)}
						onPaste={(event) => {
							if (event.clipboardData.files.length) {
								event.preventDefault();
								void attachFiles(event.clipboardData.files);
							}
						}}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing
							) {
								event.preventDefault();
								void send();
							}
						}}
					/>
					{dropActive && <p className={styles.dropHint}>Drop to attach</p>}
					{attachments.length > 0 && (
						<div className={styles.attachments} aria-label="Attached files">
							{attachments.map((item) => (
								<Button
									key={item.artifactId}
									type="button"
									variant="ghost"
									aria-label={`Remove attachment ${item.filename}`}
									onClick={() =>
										setAttachments((previous) =>
											previous.filter((a) => a.artifactId !== item.artifactId),
										)
									}
								>
									<Paperclip size={12} />
									<span dir="auto">{item.filename}</span>
									<X size={12} />
								</Button>
							))}
						</div>
					)}
					<div className={styles.controls}>
						<input
							ref={attachmentInput}
							type="file"
							multiple
							accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown,.md,.txt"
							hidden
							onChange={(event) => {
								void attachFiles(event.target.files);
								event.target.value = "";
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							aria-label="Attach files"
							disabled={busy || attaching}
							onClick={() => attachmentInput.current?.click()}
						>
							<Paperclip size={14} />
						</Button>
						<select
							aria-label="Agent model"
							value={model}
							disabled={busy || !models.length}
							onChange={(event) => setModel(event.target.value)}
						>
							<option value="" disabled>
								Select model
							</option>
							{models.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
								</option>
							))}
						</select>
						{busy ? (
							<Button type="button" variant="outline" size="sm" onClick={stop}>
								<Square size={12} />
								Stop
							</Button>
						) : (
							snapshot?.phase === "paused" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!model || !connection?.sharing}
									onClick={() => void send(true)}
								>
									<Play size={12} />
									Resume
								</Button>
							)
						)}
						<Button
							type="submit"
							size="sm"
							disabled={
								attaching || !draft.trim() || !model || !connection?.sharing
							}
						>
							{busy ? "Steer" : "Send"}
						</Button>
					</div>
					<div className={styles.footer}>
						<span>
							{attaching ? (
								"Attaching…"
							) : (
								<>
									Press <kbd>Enter</kbd> to send · <kbd>Shift Enter</kbd> for a
									new line
								</>
							)}
						</span>
						<span role="status">
							{busy
								? "Working in this project"
								: snapshot?.phase === "paused"
									? "Paused · changes retained"
									: snapshot?.phase === "failed"
										? "Task failed · changes retained"
									: "Edits can be undone in the timeline"}
						</span>
						{mode === "floating" && <GripHorizontal size={12} aria-hidden />}
					</div>
				</form>
			</aside>
		</>
	);
}

function EntryView({ entry }: { entry: Entry }) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState("");
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1800);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<article className={entry.kind === "user" ? styles.user : styles.assistant}>
			{entry.kind !== "user" && (
				<span className={styles.avatar} aria-hidden="true">
					<Bot size={12} />
				</span>
			)}
			{entry.attachments?.length ? (
				<ul>
					{entry.attachments.map((item) => (
						<li key={item.artifactId}>{item.filename}</li>
					))}
				</ul>
			) : null}
			{entry.exportUnavailable && (
				<p>Export download is unavailable after reopening.</p>
			)}
			{entry.export && (
				<div>
					{/* The exported composition owns its captions; no separate caption track is available. */}
					{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
					<video
						aria-label="Exported video preview"
						src={entry.export.url}
						controls
						preload="metadata"
						className="w-full rounded-md"
					/>
					<a href={entry.export.url} download={entry.export.filename}>
						Download video
					</a>
				</div>
			)}
			{entry.kind === "round" &&
				(entry.summary || entry.activities?.length || entry.review) && (
					<details
						className={styles.activity}
						open={
							!entry.interrupted &&
							entry.activities?.some((a) => a.status === "running")
								? true
								: undefined
						}
					>
						<summary>
							<BrainCircuit size={13} />
							{entry.review
								? "Render review"
								: entry.activities?.length === 1
									? entry.activities[0].title
									: `Reasoning summary & actions${entry.activities?.length ? ` · ${entry.activities.length}` : ""}`}
						</summary>
						{entry.summary && (
							<div
								dir="auto"
								className={`${styles.summary} ${styles.markdown}`}
							>
								<AgentMarkdown>{entry.summary}</AgentMarkdown>
							</div>
						)}
						{entry.activities?.map((activity) => (
							<details
								key={activity.callId}
								className={styles.action}
								data-ok={activity.ok}
								data-status={
									activity.status ?? (activity.ok ? "completed" : "failed")
								}
								open={
									!entry.interrupted && activity.status === "running"
										? true
										: undefined
								}
							>
								<summary>
									<Command size={12} />
									<span>{activity.title}</span>
									<ActivityDuration
										activity={activity}
										paused={entry.interrupted}
									/>
									{activity.status === "running" ? (
										entry.interrupted ? (
											<span aria-label="Awaiting resume">Ⅱ</span>
										) : (
											<LoaderCircle
												size={12}
												className="animate-spin"
												aria-label="Running"
											/>
										)
									) : (
										<span aria-label={activity.ok ? "Completed" : "Failed"}>
											{activity.ok ? "✓" : "!"}
										</span>
									)}
								</summary>
								<details>
									<summary>Input</summary>
									<pre>{JSON.stringify(activity.input, null, 2)}</pre>
								</details>
								<details>
									<summary>Output</summary>
									<pre>{JSON.stringify(activity.output, null, 2)}</pre>
								</details>
							</details>
						))}
					</details>
				)}
			{entry.text &&
				(entry.kind === "user" ? (
					<p dir={messageDirection(entry.text)}>{entry.text}</p>
				) : (
					<div dir="auto" className={styles.markdown}>
						<AgentMarkdown>{entry.text}</AgentMarkdown>
					</div>
				))}
			{entry.images?.length ? (
				<div className={styles.frames}>
					{entry.images.map((url, index) => (
						<a href={url} target="_blank" rel="noreferrer" key={url}>
							{/* These are local Blob URLs; never send project frames to an image optimizer. */}
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={url} alt={`Rendered review sample ${index + 1}`} />
						</a>
					))}
				</div>
			) : null}
			{entry.issues?.length ? (
				<ul className={styles.issues}>
					{entry.issues.map((issue, index) => (
						<li dir="auto" key={index}>
							{issue}
						</li>
					))}
				</ul>
			) : null}
			{entry.text && (
				<div
					className={styles.messageActions}
					role="group"
					aria-label="Message actions"
				>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={copied ? "Copied" : "Copy message"}
						onClick={() => {
							setCopyError("");
							void navigator.clipboard
								.writeText(entry.text)
								.then(() => setCopied(true))
								.catch(() => setCopyError("Could not copy this message"));
						}}
					>
						{copied ? <Check size={14} /> : <Copy size={14} />}
					</Button>
				</div>
			)}
			{copyError && (
				<p role="alert" className={styles.error}>
					{copyError}
				</p>
			)}
		</article>
	);
}

function ActivityDuration({
	activity,
	paused,
}: {
	activity: EditingAgentProviderRound["activities"][number];
	paused?: boolean;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (activity.status !== "running" || paused) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [activity.status, paused]);
	const elapsed =
		activity.durationMs ??
		(activity.startedAt === undefined
			? undefined
			: Math.max(0, now - activity.startedAt));
	return elapsed === undefined ? null : (
		<span className={styles.duration}>{(elapsed / 1000).toFixed(1)}s</span>
	);
}
