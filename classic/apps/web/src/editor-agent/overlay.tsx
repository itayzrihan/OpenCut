"use client";

import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useWorkspaceAccount } from "@/accounts/gate";
import type { EditorCore } from "@/core";
import { readLocalProvider } from "@/ai/local-connection";
import { AgentConnectionsSettings } from "./agent-connections-settings";
import { ElevenLabsConnectionSettings } from "@/audio-production/panel";
import { ProductionStudioPanel } from "@/production-studio/panel";
import { readProduction } from "@/production-studio/client";
import { animateDirectorHandoff } from "./production-handoff";
import { productionHandoffSnapshot } from "./production-handoff-snapshot";
import { canonical as readDirector } from "@/generative/client";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { AgentDirectorReview } from "./director-review";
import { useDirectorReviewFocus } from "@/generative/review-focus";
import { ImageGenerationReviewHost } from "./image-generation-review";
import { McpInstallationSettings } from "./mcp-installation-settings";
import { AgentSettingsSection } from "./settings-section";
import {
	useAgentSettingsNavigation,
	openAgentSettings,
} from "./settings-navigation";
import {
	readAgentModelPreference,
	saveAgentModelPreference,
} from "./model-preference";

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
	Settings,
	Square,
	X,
} from "lucide-react";
import {
	useEditor,
	useEditorHistory,
	useEditorProject,
} from "@/editor/use-editor";
import { AgentMarkdown, messageDirection } from "./markdown";
import {
	DictationControls,
	appendDictation,
	useBrowserDictation,
} from "./dictation";
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
import { getMediaTypeFromFile } from "@/media/media-utils";
import { localizeClientMessage } from "@/i18n/client-messages";
import {
	draggedProjectMedia,
	mergeAttachments,
	projectMediaAttachment,
	readProjectMediaReference,
} from "./project-media-attachments";

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
	if (process.env.NEXT_PUBLIC_EDITOR_AGENT === "0") return children;
	return (
		<div className={styles.workspace}>
			<div className={styles.editor}>{children}</div>
			<AgentPanel />
		</div>
	);
}

function clampFloatingPosition({
	left,
	top,
	bounds,
}: {
	left: number;
	top: number;
	bounds: Pick<DOMRectReadOnly, "width" | "height">;
}) {
	return {
		left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)),
		top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)),
	};
}

function AgentPanel() {
	const hosted = useWorkspaceAccount()?.hostedLegitate ?? false;
	const [open, setOpen] = useState(true);
	const [mode, setMode] = useState<"floating" | "docked">("docked");
	const editor = useEditor();
	const productionSignature = useEditorProject((e) => {
		try {
			const w = readProduction(e).workspace;
			if (
				!w.scriptRows.length &&
				!w.referenceSlots.length &&
				!w.analyses.length
			)
				return "";
			return JSON.stringify([
				w.scriptRows.map((r) => [r.id, r.currentVersion]),
				w.referenceSlots.map((r) => [r.id, r.slotVersion]),
				w.analyses.map((a) => a.id),
			]);
		} catch {
			return "";
		}
	});
	const [productionView, setProductionView] = useState({
		signature: "",
		open: false,
	});
	const productionOpen =
		productionView.signature === productionSignature
			? productionView.open
			: !!productionSignature;
	const handoff = useEditorHistory((e) => {
		try {
			const projectId = e.project.getActive().metadata.id;
			return productionHandoffSnapshot({
				projectId,
				handoff: readDirector({ editor: e }).document.productionHandoff,
			});
		} catch {
			return undefined;
		}
	});
	const lastHandoff = useRef(handoff);
	useEffect(() => {
		const previous = lastHandoff.current;
		lastHandoff.current = handoff;
		if (
			!handoff?.handoffId ||
			previous?.projectId !== handoff.projectId ||
			previous?.handoffId === handoff.handoffId
		)
			return;
		animateDirectorHandoff({
			projectId: handoff.projectId,
			referenceIds: z
				.array(z.string())
				.parse(JSON.parse(handoff.referenceIdsJson)),
			handoffId: handoff.handoffId,
		});
		useAssetsPanelStore.getState().setActiveTab("generative");
	}, [handoff]);
	const client = useRef<EditorAgentClient | null>(null);
	const mounted = useRef(true);
	const [connection, setConnection] = useState<AgentConnection | null>(null);
	const [models, setModels] = useState<AgentModel[]>([]);
	const [model, setModel] = useState("");
	const [effortOverride, setEffortOverride] = useState("");
	const selectedModel = models.find((item) => item.id === model);
	const reasoningEffort = selectedModel?.reasoningEfforts?.includes(
		effortOverride,
	)
		? effortOverride
		: selectedModel?.defaultReasoningEffort;
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
	const [policy, setPolicy] = useState(() =>
		editor.command.getEditingAgentPolicy(),
	);
	const [computerGranted, setComputerGranted] = useState(false);
	const [changingPolicy, setChangingPolicy] = useState(false);
	const desktop =
		typeof window !== "undefined" &&
		!!window.opencutElectron?.setComputerAccess;
	const policyScope = {
		accountId:
			typeof window !== "undefined"
				? (window.__opencutAccountId ?? "local")
				: "local",
		projectId: editor.project.getActiveOrNull()?.metadata.id ?? "",
	};
	useEffect(() => {
		queueMicrotask(() => {
			setComputerGranted(false);
			setPolicy(editor.command.getEditingAgentPolicy());
		});
		const unsubscribe = editor.command.subscribeHistory(() =>
			setPolicy(editor.command.getEditingAgentPolicy()),
		);
		return () => {
			unsubscribe();
			void window.opencutElectron?.revokeComputerAccess().catch(() => {});
		};
	}, [editor, policyScope.accountId, policyScope.projectId]);
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
		setError("");
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		const accountId = window.__opencutAccountId ?? "local";
		const check = () => {
			if (
				!mounted.current ||
				!projectId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				(window.__opencutAccountId ?? "local") !== accountId
			)
				throw new Error("Attachment account/project changed");
			return projectId;
		};
		try {
			if (files.length + attachments.length > 8)
				throw new Error("Attach at most eight files");
			const selected: import("@/core/agent-protocol").EditingInputAttachment[] =
				[];
			for (const file of Array.from(files)) {
				// Keep existing inline image inputs for small, supported images.
				// Audio, video and larger or other images use the project media pipeline.
				if (
					getMediaTypeFromFile({ file }) &&
					!(
						["image/png", "image/jpeg", "image/webp"].includes(file.type) &&
						file.size <= 1_000_000
					)
				) {
					const { processMediaAssets } = await import("@/media/processing");
					const [asset] = await processMediaAssets({ files: [file] });
					const target = check();
					if (!asset)
						throw new Error(
							"This file could not be imported. Try importing it into Media first.",
						);
					const saved = await editor.media.addMediaAsset({
						projectId: target,
						asset,
					});
					check();
					if (!saved)
						throw new Error("Could not attach the file to this project");
					selected.push(
						editor.command.storeEditingAttachment(
							projectMediaAttachment({ projectId: target, asset: saved }),
						),
					);
					continue;
				}
				if (file.size > 2_000_000)
					throw new Error("Attachment exceeds the two-megabyte request budget");
				const bytes = new Uint8Array(await file.arrayBuffer());
				check();
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
			setAttachments(
				mergeAttachments({ current: attachments, added: selected }),
			);
		} catch (cause) {
			if (mounted.current)
				setError(
					cause instanceof Error ? cause.message : "Could not attach files",
				);
		} finally {
			attachmentInFlight.current = false;
			if (mounted.current) setAttaching(false);
		}
	};
	const attachProjectMedia = (mediaId: string) => {
		if (busy || attachmentInFlight.current) return;
		try {
			const projectId = editor.project.getActiveOrNull()?.metadata.id;
			const asset = editor.media
				.getAssets()
				.find((item) => item.id === mediaId);
			if (!projectId || !asset)
				throw new Error("This media is unavailable in the current project");
			if (
				attachments.some(
					({ artifactId }) =>
						resolveProjectAttachment({ editor, artifactId })?.mediaId ===
						mediaId,
				)
			) {
				composerInput.current?.focus();
				return;
			}
			if (attachments.length >= 8)
				throw new Error("Attach at most eight files");
			const attachment = editor.command.storeEditingAttachment(
				projectMediaAttachment({ projectId, asset }),
			);
			setAttachments(
				mergeAttachments({ current: attachments, added: [attachment] }),
			);
			setError("");
			composerInput.current?.focus();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not attach project media",
			);
		}
	};
	const [busy, setBusy] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const dictation = useBrowserDictation({
		enabled: open && !settingsOpen,
		scope: JSON.stringify(policyScope),
		onTranscript: (transcript) =>
			setDraft((draft) => appendDictation({ draft, transcript })),
	});
	const settingsProvider = useAgentSettingsNavigation(
		(state) => state.provider,
	);
	const [connectionReveal, setConnectionReveal] = useState(0);
	useEffect(
		() =>
			useDirectorReviewFocus.subscribe((state, previous) => {
				if (
					state.surface !== "agent" ||
					!state.jobId ||
					(state.jobId === previous.jobId && state.surface === previous.surface)
				)
					return;
				if (
					state.accountId !== window.__opencutAccountId ||
					state.projectId !== editor.project.getActiveOrNull()?.metadata.id
				)
					return;
				setOpen(true);
				setSettingsOpen(false);
			}),
		[editor],
	);
	useEffect(
		() =>
			useAgentSettingsNavigation.subscribe((state, previous) => {
				if (state.request === previous.request) return;
				setOpen(true);
				setMode("docked");
				setSettingsOpen(true);
				setConnectionReveal(state.request);
			}),
		[],
	);
	const [error, setError] = useState("");
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
	}, [draft, mode, open, settingsOpen]);
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
						allowed: ["video/webm", "video/mp4", "application/pdf"],
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
			setSettingsOpen(false);
			setOpen(true);
		};
		const openConnections = () => {
			openAgentSettings();
		};
		window.addEventListener("opencut-agent-connections", openConnections);
		window.addEventListener(EDITING_AGENT_DRAFT_EVENT, receiveDraft);
		return () => {
			window.removeEventListener("opencut-agent-connections", openConnections);
			window.removeEventListener(EDITING_AGENT_DRAFT_EVENT, receiveDraft);
		};
	}, [editor]);
	const receive = useCallback(
		(event: AgentClientEvent) => {
			if (!mounted.current) return;
			if (event.type === "conversation") {
				setEntries(projectEntries(event.entries));
				return;
			}
			if (event.type === "snapshot") {
				setSnapshot(event.snapshot);
				setPolicy(editor.command.getEditingAgentPolicy());
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
		const account = window.__opencutAccountId;
		const provider = readLocalProvider();
		const status = await connectionRequest({
			signal,
			schema: connectionSchemas.status,
		}).catch((cause) => {
			if (
				provider &&
				mounted.current &&
				!signal?.aborted &&
				window.__opencutAccountId === account &&
				readLocalProvider() === provider
			) {
				setConnection(null);
				setModels([]);
			}
			throw cause;
		});
		if (!mounted.current || signal?.aborted) return;
		setConnection(status);
		window.dispatchEvent(new Event("opencut-ai-connected"));
		const catalog = status.sharing
			? await connectionRequest({
					operation: "models",
					schema: connectionSchemas.models,
					signal,
				})
			: { models: [] };
		if (!mounted.current || signal?.aborted) return;
		const preference = readAgentModelPreference();
		const nextModel =
			catalog.models.find((item) => item.id === preference?.model) ??
			catalog.models[0];
		const effort =
			preference?.model === nextModel?.id
				? preference?.reasoningEffort
				: undefined;
		const nextEffort =
			effort && nextModel?.reasoningEfforts?.includes(effort)
				? effort
				: undefined;
		setModels(catalog.models);
		setModel(nextModel?.id ?? "");
		setEffortOverride(nextEffort ?? "");
		if (nextModel)
			saveAgentModelPreference({
				model: nextModel.id,
				reasoningEffort: nextEffort,
			});
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
			void window.opencutElectron?.revokeComputerAccess().catch(() => {});
			window.removeEventListener("pagehide", pause);
		};
	}, [editor, receive, refresh]);
	useEffect(() => {
		if (follow.current && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [entries, mode, open, settingsOpen, snapshot]);
	useEffect(() => {
		const element = panel.current;
		if (mode !== "floating" || !open || !element) return;
		const clamp = () => {
			const bounds = element.getBoundingClientRect();
			setPosition((old) => {
				if (!old) return old;
				const next = clampFloatingPosition({ ...old, bounds });
				return next.left === old.left && next.top === old.top ? old : next;
			});
		};
		const observer = new ResizeObserver(clamp);
		observer.observe(element);
		window.addEventListener("resize", clamp);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", clamp);
		};
	}, [mode, open]);
	const send = async (resume = false) => {
		const text = resume
			? undefined
			: draft.trim() ||
				(attachments.length
					? localizeClientMessage(
							"Describe the attached media using its available content.",
						)
					: undefined);
		if (
			(!text && !resume) ||
			changingPolicy ||
			!client.current ||
			!model ||
			!connection?.sharing ||
			attachmentInFlight.current
		)
			return;
		const attempt = ++generation.current;
		dictation.cancel();
		setDraft("");
		setError("");
		setBusy(true);
		follow.current = true;
		setFollowing(true);
		try {
			const selected = !resume && attachments.length ? attachments : undefined;
			if (!resume) setAttachments([]);
			await client.current.run({
				text,
				model,
				reasoningEffort,
				attachments: selected,
			});
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
		void window.opencutElectron?.cancelComputerOperations().catch(() => {});
		setBusy(false);
	};
	const changePolicy = async ({
		mode,
		computerAccess,
	}: {
		mode: typeof policy.mode;
		computerAccess: boolean;
	}) => {
		stop();
		setChangingPolicy(true);
		setError("");
		try {
			await window.opencutElectron?.revokeComputerAccess();
			setComputerGranted(false);
			await editor.command.setEditingAgentPolicy({ mode, computerAccess });
			let next = editor.command.getEditingAgentPolicy();
			if (computerAccess) {
				const result = await window.opencutElectron!.setComputerAccess({
					...policyScope,
					mode: next.mode,
					generation: next.generation,
					enabled: true,
				});
				if (!result.enabled) {
					await editor.command.setEditingAgentPolicy({
						mode,
						computerAccess: false,
					});
					next = editor.command.getEditingAgentPolicy();
				}
				setComputerGranted(result.enabled);
			}
			setPolicy(next);
			setSnapshot(editor.command.getEditingAgentSnapshot());
		} catch (cause) {
			setPolicy(editor.command.getEditingAgentPolicy());
			setError(
				cause instanceof Error ? cause.message : "Could not change permissions",
			);
		} finally {
			setChangingPolicy(false);
		}
	};
	const approve = async (allow: boolean) => {
		if (!snapshot?.pendingApproval) return;
		try {
			editor.command.executeEditingAgentCommand({
				type: "approve",
				approvalId: snapshot.pendingApproval.approvalId,
				allow,
			});
			setSnapshot(editor.command.getEditingAgentSnapshot());
			await send(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Approval expired");
		}
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
		const bounds = panel.current?.getBoundingClientRect();
		if (!drag.current || !bounds) return;
		setPosition(
			clampFloatingPosition({
				left: drag.current.left + event.clientX - drag.current.x,
				top: drag.current.top + event.clientY - drag.current.y,
				bounds,
			}),
		);
	};
	return (
		<>
			<ImageGenerationReviewHost
				accountId={
					typeof window !== "undefined"
						? (window.__opencutAccountId ?? "local")
						: "local"
				}
				projectId={editor.project.getActiveOrNull()?.metadata.id}
			/>
			{!open && (
				<Button className={styles.launcher} onClick={() => setOpen(true)}>
					<Bot />{" "}
					{busy ? (
						<UiMessage text={"Agent is editing…"} />
					) : (
						<UiMessage text={"POCUT Agent"} />
					)}
				</Button>
			)}
			<UiLocalized<"aside">
				element={"aside"}
				messageProps={["aria-label"]}
				ref={panel}
				aria-label="POCUT editing agent"
				data-testid="editor-agent"
				className={`${styles.panel} ${mode === "docked" ? styles.docked : styles.floating}`}
				hidden={!open}
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
					<strong>
						<UiMessage text={"POCUT Agent"} />
					</strong>
					<Button
						variant="ghost"
						size="sm"
						aria-pressed={settingsOpen}
						onClick={() => {
							setConnectionReveal(0);
							setSettingsOpen(!settingsOpen);
						}}
					>
						<Settings size={14} /> <UiMessage text={"Settings"} />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-pressed={productionOpen && !settingsOpen}
						onClick={() => {
							setSettingsOpen(false);
							setProductionView({
								signature: productionSignature,
								open: !productionOpen,
							});
						}}
					>
						<UiMessage text="Production" />
					</Button>
					<span className={styles.badge}>
						<UiMessage text={"Preview"} />
					</span>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["title", "aria-label"]}
						variant="ghost"
						size="icon"
						title={mode === "docked" ? "Float chat" : "Dock chat"}
						aria-label={mode === "docked" ? "Float chat" : "Dock chat"}
						onClick={() => setMode(mode === "docked" ? "floating" : "docked")}
					>
						<PanelRight />
					</UiLocalized>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["aria-label"]}
						variant="ghost"
						size="icon"
						aria-label="Minimize chat"
						onClick={() => {
							setSettingsOpen(false);
							setOpen(false);
						}}
					>
						<Minus />
					</UiLocalized>
				</header>
				{open && settingsOpen && (
					<UiLocalized<"section">
						element={"section"}
						messageProps={["aria-label"]}
						className={styles.settings}
						aria-label="Agent settings"
					>
						<AgentConnectionsSettings
							connection={connection}
							refresh={refresh}
							stop={stop}
							revealRequest={connectionReveal}
							revealProvider={settingsProvider}
						/>
						<AgentSettingsSection title="ElevenLabs">
							<ElevenLabsConnectionSettings
								projectId={editor.project.getActive().metadata.id}
							/>
						</AgentSettingsSection>
						{!hosted && (
							<AgentSettingsSection title="Editor MCP connection">
								<McpInstallationSettings
									key={editor.project.getActive().metadata.id}
									projectId={editor.project.getActive().metadata.id}
								/>
							</AgentSettingsSection>
						)}
						<AgentSettingsSection title="Skills & memory">
							<KnowledgePanel
								projectId={editor.project.getActive().metadata.id}
							/>
						</AgentSettingsSection>
					</UiLocalized>
				)}
				<UiLocalized<"div">
					element={"div"}
					messageProps={["aria-label"]}
					ref={scroll}
					hidden={settingsOpen}
					className={styles.messages}
					data-production-board="true"
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
							{connection && !connection.sharing && (
								<Button variant="outline" onClick={() => setSettingsOpen(true)}>
									<UiMessage text="Connect AI provider" />
								</Button>
							)}
							<h2>
								<UiMessage text={"What should change in your video?"} />
							</h2>
							<p>
								<UiMessage
									text={
										"Describe the edit. Follow the plan, inspect each action, and refine the result as we work."
									}
								/>
							</p>
						</div>
					)}
					{entries.map((entry) => (
						<EntryView key={entry.id} entry={entry} />
					))}
					{productionOpen && <ProductionStudioPanel className="mt-4" />}
					<AgentDirectorReview
						projectId={editor.project.getActive().metadata.id}
					/>
					{snapshot?.plan.length ? (
						<details className={styles.plan} open>
							<summary>
								<UiMessage text={"Editing plan"} />
							</summary>
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
				</UiLocalized>
				{!following && !settingsOpen && (
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
						<ArrowDown size={12} /> <UiMessage text={"Latest messages"} />
					</Button>
				)}
				{(error || connection?.error) && (
					<div className={styles.error} role="alert">
						<span>{error || connection?.error}</span>
						<UiLocalized<typeof Button>
							element={Button}
							messageProps={["aria-label"]}
							variant="ghost"
							size="icon"
							aria-label="Dismiss error"
							onClick={() => {
								setError("");
								setConnection((old) => (old ? { ...old, error: null } : old));
							}}
						>
							<X />
						</UiLocalized>
					</div>
				)}
				{!settingsOpen && snapshot?.pendingApproval && (
					<UiLocalized<"section">
						element={"section"}
						messageProps={["aria-label"]}
						className={styles.approval}
						aria-label="Operation approval"
					>
						<strong>
							<UiMessage text={"Approval required"} />
						</strong>
						<p>{snapshot.pendingApproval.capabilityId}</p>
						<details>
							<summary>
								<UiMessage text={"Review exact operation"} />
							</summary>
							<pre>
								{JSON.stringify(snapshot.pendingApproval.input, null, 2)}
							</pre>
						</details>
						<div>
							<Button
								type="button"
								size="sm"
								onClick={() => void approve(true)}
								disabled={busy}
							>
								<UiMessage text={"Allow once"} />
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void approve(false)}
								disabled={busy}
							>
								<UiMessage text={"Deny"} />
							</Button>
						</div>
					</UiLocalized>
				)}
				{!settingsOpen &&
					policy.mode === "plan" &&
					snapshot?.phase === "completed" && (
						<UiLocalized<"section">
							element={"section"}
							messageProps={["aria-label"]}
							className={styles.approval}
							aria-label="Proposed plan"
						>
							<strong>
								<UiMessage text={"Plan ready for review"} />
							</strong>
							<p>
								<UiMessage
									text={
										"No edits were executed in Plan mode. Choose an execution mode, then send your instructions to carry out this plan."
									}
								/>
							</p>
							<Button
								type="button"
								size="sm"
								onClick={() =>
									void changePolicy({
										mode: "askDestructive",
										computerAccess: computerGranted,
									})
								}
								disabled={changingPolicy}
							>
								<UiMessage text={"Use plan · confirm destructive actions"} />
							</Button>
						</UiLocalized>
					)}
				<UiLocalized<"form">
					element={"form"}
					messageProps={["aria-label"]}
					hidden={settingsOpen}
					className={`${styles.composer} ${dropActive ? styles.dropActive : ""}`}
					aria-label="Chat message composer"
					onDragOver={(event) => {
						if (
							event.dataTransfer.types.includes("Files") ||
							draggedProjectMedia({
								types: event.dataTransfer.types,
								active: editor.timeline.dragSource.getActive(),
							})
						) {
							event.preventDefault();
							event.stopPropagation();
							event.dataTransfer.dropEffect =
								busy || attaching ? "none" : "copy";
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
						const mediaId = draggedProjectMedia({
							types: event.dataTransfer.types,
							active: editor.timeline.dragSource.getActive(),
						});
						if (!mediaId && !event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						event.stopPropagation();
						setDropActive(false);
						if (mediaId) attachProjectMedia(mediaId);
						else void attachFiles(event.dataTransfer.files);
					}}
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<UiLocalized<typeof Textarea>
						element={Textarea}
						messageProps={["aria-label", "placeholder"]}
						ref={composerInput}
						dir={messageDirection(draft)}
						aria-label="Message the editing agent"
						placeholder={
							busy
								? "Add a correction or change direction…"
								: "Describe your edit or drop media…"
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
					{dropActive && (
						<p className={styles.dropHint}>
							<UiMessage text={"Drop to attach"} />
						</p>
					)}
					{attachments.length > 0 && (
						<UiLocalized<"div">
							element={"div"}
							messageProps={["aria-label"]}
							className={styles.attachments}
							aria-label="Attached files"
						>
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
						</UiLocalized>
					)}
					{dictation.error && (
						<p role="status" className="text-xs text-muted-foreground">
							<UiMessage text={dictation.error} />
						</p>
					)}
					<div className={styles.controls}>
						<input
							ref={attachmentInput}
							type="file"
							multiple
							accept="image/*,video/*,audio/*,application/pdf,text/plain,text/markdown,.md,.txt"
							hidden
							onChange={(event) => {
								void attachFiles(event.target.files);
								event.target.value = "";
							}}
						/>
						<UiLocalized<typeof Button>
							element={Button}
							messageProps={["aria-label"]}
							type="button"
							variant="ghost"
							aria-label="Attach files"
							disabled={busy || attaching}
							onClick={() => attachmentInput.current?.click()}
						>
							<Paperclip size={14} />
						</UiLocalized>
						<DictationControls draft={draft} dictation={dictation} />
						<div className={styles.providerControls}>
							<UiLocalized<"select">
								element={"select"}
								messageProps={["aria-label"]}
								aria-label="Agent model"
								value={model}
								disabled={busy || !models.length}
								onChange={(event) => {
									const nextModel = event.target.value;
									setModel(nextModel);
									setEffortOverride("");
									saveAgentModelPreference({ model: nextModel });
								}}
							>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value=""
									disabled
								>
									{"Select model"}
								</UiLocalized>
								{models.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</UiLocalized>
							<label className={styles.effort}>
								<UiMessage text={"Effort"} />
								<UiLocalized<"select">
									element={"select"}
									messageProps={["aria-label"]}
									aria-label="Reasoning effort"
									value={reasoningEffort ?? ""}
									disabled={busy || !selectedModel?.reasoningEfforts?.length}
									onChange={(event) => {
										const effort = event.target.value;
										setEffortOverride(effort);
										saveAgentModelPreference({
											model,
											reasoningEffort: effort || undefined,
										});
									}}
								>
									{!selectedModel?.defaultReasoningEffort && (
										<UiLocalized<"option">
											element={"option"}
											messageProps={["children"]}
											value=""
										>
											{"Default"}
										</UiLocalized>
									)}
									{selectedModel?.reasoningEfforts?.map((effort) => (
										<option key={effort} value={effort}>
											{effort === "xhigh" ? (
												<UiMessage text={"Extra high"} />
											) : (
												effort.charAt(0).toUpperCase() + effort.slice(1)
											)}
										</option>
									))}
								</UiLocalized>
							</label>
						</div>
						{busy ? (
							<Button type="button" variant="outline" size="sm" onClick={stop}>
								<Square size={12} />
								<UiMessage text={"Stop"} />
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
									<UiMessage text={"Resume"} />
								</Button>
							)
						)}
						<Button
							type="submit"
							size="sm"
							disabled={
								attaching ||
								(!draft.trim() && !attachments.length) ||
								!model ||
								!connection?.sharing
							}
						>
							{busy ? (
								<UiMessage text={"Steer"} />
							) : (
								<UiMessage text={"Send"} />
							)}
						</Button>
					</div>
					<UiLocalized<"div">
						element={"div"}
						messageProps={["aria-label"]}
						className={styles.permissions}
						aria-label="Agent permissions"
					>
						<label>
							<UiMessage text={"Mode"} />{" "}
							<UiLocalized<"select">
								element={"select"}
								messageProps={["aria-label"]}
								aria-label="Agent permission mode"
								value={policy.mode}
								disabled={changingPolicy}
								onChange={(event) =>
									void changePolicy({
										mode: z
											.enum(["plan", "askDestructive", "fullAccess"])
											.parse(event.target.value),
										computerAccess: computerGranted,
									})
								}
							>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="plan"
								>
									{"Plan · inspect only"}
								</UiLocalized>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="askDestructive"
								>
									{"Confirm destructive actions"}
								</UiLocalized>
								<UiLocalized<"option">
									element={"option"}
									messageProps={["children"]}
									value="fullAccess"
								>
									{"Full access"}
								</UiLocalized>
							</UiLocalized>
						</label>
						{desktop && (
							<label className={styles.computerToggle}>
								<input
									type="checkbox"
									checked={computerGranted}
									disabled={changingPolicy}
									onChange={(event) =>
										void changePolicy({
											mode: policy.mode,
											computerAccess: event.target.checked,
										})
									}
								/>{" "}
								<UiMessage text={"Computer access"} />{" "}
								{computerGranted ? (
									<UiMessage text={"on"} />
								) : (
									<UiMessage text={"off"} />
								)}
							</label>
						)}
						{computerGranted && (
							<p>
								{policy.mode === "fullAccess" ? (
									<UiMessage
										text={
											"Computer files and terminal · no individual approvals"
										}
									/>
								) : policy.mode === "plan" ? (
									<UiMessage text={"Computer files · inspection only"} />
								) : (
									<UiMessage
										text={"Computer files and terminal · confirm changes"}
									/>
								)}
							</p>
						)}
					</UiLocalized>
					<div className={styles.footer}>
						{attaching && (
							<span>
								<UiMessage text={"Attaching…"} />
							</span>
						)}
						<span role="status">
							{busy ? (
								computerGranted ? (
									<UiMessage text={"Working with computer access"} />
								) : policy.mode === "plan" ? (
									<UiMessage text={"Planning · inspection only"} />
								) : (
									<UiMessage text={"Working in this project"} />
								)
							) : snapshot?.phase === "paused" ? (
								<UiMessage text={"Paused · changes retained"} />
							) : snapshot?.phase === "failed" ? (
								<UiMessage text={"Task failed · changes retained"} />
							) : computerGranted ? (
								<UiMessage text={"Computer changes are outside editor undo"} />
							) : null}
						</span>
						{mode === "floating" && <GripHorizontal size={12} aria-hidden />}
					</div>
				</UiLocalized>
			</UiLocalized>
		</>
	);
}

/** Presentation of the live capability payload; no tool execution or policy here. */
function ComputerOperationView({
	input,
	output,
}: {
	input: unknown;
	output: unknown;
}) {
	const action = z
		.object({
			action: z.literal("invoke"),
			id: z.string().startsWith("computer."),
			input: z
				.object({
					operation: z
						.object({
							type: z.string(),
							path: z.string().optional(),
							command: z.string().optional(),
							cwd: z.string().optional(),
							content: z.string().optional(),
						})
						.passthrough(),
				})
				.passthrough(),
		})
		.safeParse(input);
	if (!action.success) return null;
	const operation = action.data.input.operation;
	const data = z
		.object({
			result: z.object({
				result: z.object({ data: z.object({ text: z.string() }) }),
			}),
		})
		.safeParse(output);
	let display = "";
	if (data.success) {
		try {
			const result: unknown = JSON.parse(data.data.result.result.data.text);
			const text = z
				.object({ output: z.string().optional(), text: z.string().optional() })
				.safeParse(result);
			display = text.success
				? (text.data.output ??
					text.data.text ??
					JSON.stringify(result, null, 2))
				: JSON.stringify(result, null, 2);
		} catch {
			display = data.data.result.result.data.text;
		}
	}
	return (
		<UiLocalized<"section">
			element={"section"}
			messageProps={["aria-label"]}
			className={styles.computerOperation}
			aria-label="Computer operation"
		>
			<strong>
				{operation.type === "shell" ? (
					<UiMessage text={"Terminal"} />
				) : (
					<UiMessage
						text={"Files · {v0}"}
						values={{ v0: String(operation.type) }}
					/>
				)}
			</strong>
			<code dir="ltr">{operation.command ?? operation.path}</code>
			{operation.cwd && <p dir="ltr">{operation.cwd}</p>}
			{operation.content && (
				<details>
					<summary>
						<UiMessage text={"File content"} />
					</summary>
					<pre dir="auto">{operation.content}</pre>
				</details>
			)}
			{display && <pre dir="auto">{display}</pre>}
		</UiLocalized>
	);
}

function resolveProjectAttachment({
	editor,
	artifactId,
}: {
	editor: EditorCore;
	artifactId: string;
}) {
	try {
		const reference = readProjectMediaReference(
			editor.command.readEditingConversationArtifact(artifactId),
		);
		if (reference?.projectId === editor.project.getActiveOrNull()?.metadata.id)
			return reference;
	} catch {
		// The project or attachment may no longer be available.
	}
	return undefined;
}

function EntryView({ entry }: { entry: Entry }) {
	const editor = useEditor();
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
					{entry.attachments.map((item) => {
						const mediaId = resolveProjectAttachment({
							editor,
							artifactId: item.artifactId,
						})?.mediaId;
						return (
							<li key={item.artifactId}>
								{mediaId &&
								editor.media
									.getAssets()
									.some((asset) => asset.id === mediaId) ? (
									<button
										type="button"
										className="underline underline-offset-2"
										onClick={() =>
											useAssetsPanelStore.getState().requestRevealMedia(mediaId)
										}
									>
										<bdi>{item.filename}</bdi>
									</button>
								) : (
									<bdi>{item.filename}</bdi>
								)}
							</li>
						);
					})}
				</ul>
			) : null}
			{entry.exportUnavailable && (
				<p>
					<UiMessage text={"Export download is unavailable after reopening."} />
				</p>
			)}
			{entry.export && (
				<div>
					{/* The exported composition owns its captions; no separate caption track is available. */}
					<UiLocalized<"video">
						element={"video"}
						messageProps={["aria-label"]}
						aria-label="Exported video preview"
						src={entry.export.url}
						controls
						preload="metadata"
						className="w-full rounded-md"
					/>
					<a href={entry.export.url} download={entry.export.filename}>
						<UiMessage text={"Download video"} />
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
							{entry.review ? (
								<UiMessage text={"Render review"} />
							) : entry.activities?.length === 1 ? (
								entry.activities[0].title
							) : (
								<UiMessage
									text={"Reasoning summary & actions{v0}"}
									values={{
										v0: String(
											entry.activities?.length
												? ` · ${entry.activities.length}`
												: "",
										),
									}}
								/>
							)}
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
											<UiLocalized<"span">
												element={"span"}
												messageProps={["aria-label"]}
												aria-label="Awaiting resume"
											>
												Ⅱ
											</UiLocalized>
										) : (
											<UiLocalized<typeof LoaderCircle>
												element={LoaderCircle}
												messageProps={["aria-label"]}
												size={12}
												className="animate-spin"
												aria-label="Running"
											/>
										)
									) : (
										<UiLocalized<"span">
											element={"span"}
											messageProps={["aria-label"]}
											aria-label={activity.ok ? "Completed" : "Failed"}
										>
											{activity.ok ? "✓" : "!"}
										</UiLocalized>
									)}
								</summary>
								<ComputerOperationView
									input={activity.input}
									output={activity.output}
								/>
								<details>
									<summary>
										<UiMessage text={"Input"} />
									</summary>
									<pre>{JSON.stringify(activity.input, null, 2)}</pre>
								</details>
								<details>
									<summary>
										<UiMessage text={"Output"} />
									</summary>
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
				<UiLocalized<"div">
					element={"div"}
					messageProps={["aria-label"]}
					className={styles.messageActions}
					role="group"
					aria-label="Message actions"
				>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["aria-label"]}
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
					</UiLocalized>
				</UiLocalized>
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
