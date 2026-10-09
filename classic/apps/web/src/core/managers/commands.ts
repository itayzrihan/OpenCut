import { collectTakeAudioEvidence } from "@/timeline/smart-takes/audio-evidence";
import { assertBatchEditable } from "@/batch/read-only";
import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import { storageService } from "@/services/storage/service";
import type {
	SerializedCommandHistoryEntry,
	SerializedProjectHistorySnapshot,
	SerializedCommandHistory,
} from "@/services/storage/types";
import type { TProject } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { SceneTracks } from "@/timeline/types";
import type { MediaAsset } from "@/media/types";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import { generateUUID } from "@/utils/id";
import type {
	EditingAgentCommand,
	EditingAgentProviderRequest,
	EditingAgentProviderRound,
	EditingAgentReviewPlan,
	EditingAgentReviewResult,
	EditingAgentReviewRequest,
	EditingAgentSnapshot,
} from "@/core/agent-protocol";
import { localMediaUrl } from "@/services/local-drive/client";
import type { EditorSessionBundle } from "@/editor-agent/session-client";
import {
	CanonicalClassicSession,
	canonicalMediaBindings,
	type CanonicalClassicSnapshot,
	type CanonicalHistoryArchive,
	type CanonicalHistoryBoundary,
	type CanonicalSilenceOperation,
} from "@/core/canonical-classic-session";

const COMMAND_HISTORY_SCHEMA_VERSION = 1;
const MAX_PERSISTED_HISTORY_ENTRIES = 100;

interface CommandHistoryEntry {
	command?: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	beforeSnapshot?: SerializedProjectHistorySnapshot;
	afterSnapshot?: SerializedProjectHistorySnapshot;
	beforeMedia?: CanonicalClassicSnapshot["mediaAssets"];
	afterMedia?: CanonicalClassicSnapshot["mediaAssets"];
}

interface CanonicalCallback {
	undo: () => void;
	redo: () => CommandResult | undefined;
	effectsOnly?: boolean;
	applyRipple?: boolean;
	runReactors?: boolean;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private historyListeners = new Set<() => void>();
	private reactors: Array<() => void> = [];
	private activeProjectId: string | null = null;
	private historySaveQueue: Promise<void> = Promise.resolve();
	private scheduledSessionSave: {
		session: CanonicalClassicSession;
		accountId: string;
		promise: Promise<void>;
	} | null = null;
	private transactionDepth = 0;
	private stateRevision = 0;
	private canonical: CanonicalClassicSession | null = null;
	private canonicalArchive: CanonicalHistoryArchive | null = null;
	private sessionPersistence:
		| ((capture: () => EditorSessionBundle) => Promise<void>)
		| null = null;
	private canonicalCallbacks = new Map<string, CanonicalCallback>();
	private canonicalFrameCommands: Command[] = [];
	// IO handles are not editor state; retain them for canonical Undo/reopening.
	private canonicalMediaHandles = new Map<string, MediaAsset>();
	private isProjectingCanonical = false;
	private settingsGesture: { id: string; keys: string } | undefined;
	private effectGesture: { id: string; target: string } | undefined;
	private unsubscribeEffectCatalog: (() => void) | null = null;
	private unsubscribeMaskCatalog: (() => void) | null = null;
	private unsubscribeAnimationCatalog: (() => void) | null = null;
	private maskPreview: {
		session: CanonicalClassicSession;
		accountId: string;
		request: Parameters<CanonicalClassicSession["editMask"]>[0];
	} | null = null;
	private silenceCommit: {
		operation: CanonicalSilenceOperation;
		sceneId: string;
	} | null = null;

	constructor(private editor: EditorCore) {}

	subscribeHistory(listener: () => void): () => void {
		this.historyListeners.add(listener);
		return () => {
			this.historyListeners.delete(listener);
		};
	}

	execute({
		command,
		applyRipple = true,
		runReactors = true,
	}: {
		command: Command;
		applyRipple?: boolean;
		runReactors?: boolean;
	}): Command {
		assertBatchEditable(this.editor.project.getActiveOrNull()?.metadata.id);
		const shouldRecordHistory = this.transactionDepth === 0;
		const beforeSnapshot =
			shouldRecordHistory && !this.canonical
				? this.captureProjectSnapshot()
				: null;
		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const beforeMedia = beforeSnapshot
			? this.captureMediaBindings()
			: undefined;
		const canonicalOuter = shouldRecordHistory && this.canonical !== null;
		let transactionOpen = false;
		if (canonicalOuter) {
			this.canonical?.begin();
			transactionOpen = true;
			this.canonicalFrameCommands = [];
			this.transactionDepth += 1;
		}
		try {
			const result = command.execute();
			this.stateRevision += 1;
			if (applyRipple) this.applyRippleIfEnabled({ beforeTracks });
			const selectionOverride = this.applySelectionOverride(result);
			if (runReactors) this.runReactors();
			if (!shouldRecordHistory) {
				if (this.canonical && !this.isProjectingCanonical)
					this.canonicalFrameCommands.push(command);
				return command;
			}
			if (this.canonical) {
				this.synchronizeCanonicalViews();
				const callbackId = generateUUID();
				this.canonical.commit({
					label: command.constructor.name || "Editor command",
					hostContext: {
						callbackId,
						persistable: command.canPersistHistory,
						previousSelection,
						...(selectionOverride !== undefined && { selectionOverride }),
					},
				});
				transactionOpen = false;
				this.canonicalCallbacks.set(callbackId, {
					undo: () => command.undo(),
					redo: () => command.redo(),
					applyRipple,
					runReactors,
				});
				this.persistHistory();
				return command;
			}
			const afterSnapshot = this.captureProjectSnapshot();
			this.history.push({
				command,
				previousSelection,
				selectionOverride,
				beforeSnapshot: beforeSnapshot ?? undefined,
				afterSnapshot: afterSnapshot ?? undefined,
				beforeMedia,
				afterMedia: afterSnapshot ? this.captureMediaBindings() : undefined,
			});
			this.redoStack = [];
			this.persistHistory();
			return command;
		} catch (error) {
			if (transactionOpen && this.canonical) {
				this.canonical.rollback();
				this.publishCanonical();
				this.editor.selection.restoreSnapshot({ snapshot: previousSelection });
			}
			throw error;
		} finally {
			if (canonicalOuter) {
				this.transactionDepth -= 1;
				this.canonicalFrameCommands = [];
			}
		}
	}

	/** Publish a prepared silence edit through its scoped Rust contract. Analysis
	 * must finish before this synchronous, single-history-boundary operation. */
	executeSilenceTransaction<T>({
		operation,
		execute,
	}: {
		operation: CanonicalSilenceOperation;
		execute: () => T;
	}): T {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Enable the canonical project before applying a silence edit",
			);
		if (this.transactionDepth !== 0 || this.silenceCommit)
			throw new Error("A silence edit must start its own atomic transaction");
		this.silenceCommit = { operation, sceneId };
		try {
			return this.executeTransaction({ execute });
		} finally {
			this.silenceCommit = null;
		}
	}

	/** Execute several editor commands as one atomic, persisted undo entry. */
	executeTransaction<T>({
		execute,
		retainMediaResources = false,
	}: {
		execute: () => T;
		retainMediaResources?: boolean;
	}): T {
		assertBatchEditable(this.editor.project.getActiveOrNull()?.metadata.id);
		if (this.transactionDepth > 0) {
			return execute();
		}

		const beforeSnapshot = this.canonical
			? null
			: this.captureProjectSnapshot();
		const previousSelection = this.getSelectionSnapshot();
		this.canonical?.begin();
		let transactionOpen = this.canonical !== null;
		this.canonicalFrameCommands = [];
		this.transactionDepth += 1;
		try {
			const result = execute();
			if (this.canonical) {
				this.synchronizeCanonicalViews();
				const effects = this.canonicalFrameCommands.filter(
					(command) => !command.canPersistHistory,
				);
				const callbackId = effects.length ? generateUUID() : undefined;
				this.canonical.commit({
					label: "Editor transaction",
					hostContext: {
						previousSelection,
						selectionOverride: this.getSelectionSnapshot(),
						persistable: effects.length === 0,
						retainMediaResources: retainMediaResources || effects.length > 0,
						...(callbackId && { callbackId }),
					},
				});
				transactionOpen = false;
				if (callbackId)
					this.canonicalCallbacks.set(callbackId, {
						effectsOnly: true,
						undo: () => {
							for (const command of [...effects].reverse()) command.undo();
						},
						redo: () => {
							for (const command of effects) command.redo();
							return undefined;
						},
					});
				this.stateRevision += 1;
				this.persistHistory();
				return result;
			}
			const afterSnapshot = this.captureProjectSnapshot();
			if (beforeSnapshot && afterSnapshot) {
				this.history.push({
					previousSelection,
					selectionOverride: this.getSelectionSnapshot(),
					beforeSnapshot,
					afterSnapshot,
				});
				this.redoStack = [];
				this.stateRevision += 1;
				this.persistHistory();
			}
			return result;
		} catch (error) {
			if (transactionOpen && this.canonical) {
				this.canonical.rollback();
				this.publishCanonical();
			}
			if (beforeSnapshot) {
				this.restoreProjectSnapshot({ snapshot: beforeSnapshot });
			}
			if (transactionOpen || beforeSnapshot)
				this.editor.selection.restoreSnapshot({ snapshot: previousSelection });
			throw error;
		} finally {
			this.transactionDepth -= 1;
			this.canonicalFrameCommands = [];
		}
	}

	push({
		command,
		beforeSnapshot,
	}: {
		command: Command;
		beforeSnapshot?: SerializedProjectHistorySnapshot | null;
	}): void {
		if (this.canonical) {
			if (beforeSnapshot) {
				this.canonical.synchronize({
					classic: {
						document: beforeSnapshot,
						mediaAssets: this.captureMediaBindings(),
					},
				});
				this.publishCanonical();
			}
			this.execute({ command, applyRipple: false, runReactors: false });
			return;
		}
		this.history.push({
			command,
			previousSelection: this.getSelectionSnapshot(),
			beforeSnapshot: command.canPersistHistory
				? (beforeSnapshot ?? this.captureProjectSnapshot() ?? undefined)
				: undefined,
			afterSnapshot: command.canPersistHistory
				? (this.captureProjectSnapshot() ?? undefined)
				: undefined,
		});
		this.redoStack = [];
		this.stateRevision += 1;
		this.persistHistory();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	async loadHistory({
		projectId,
		history,
	}: {
		projectId: string;
		history?: SerializedCommandHistory | null;
	}): Promise<void> {
		this.releaseCanonical();
		this.activeProjectId = projectId;

		try {
			const persisted =
				history === undefined
					? await storageService.loadCommandHistory({ projectId })
					: history;
			if (this.activeProjectId !== projectId) {
				return;
			}
			if (
				persisted?.projectId === projectId &&
				persisted.schemaVersion === 2 &&
				persisted.canonicalArchive
			) {
				this.canonicalArchive = persisted.canonicalArchive;
				this.history = [];
				this.redoStack = [];
				this.stateRevision += 1;
				return;
			}
			if (
				!persisted ||
				persisted.projectId !== projectId ||
				persisted.schemaVersion !== COMMAND_HISTORY_SCHEMA_VERSION
			) {
				this.history = [];
				this.redoStack = [];
				this.stateRevision += 1;
				return;
			}

			this.history = persisted.undoStack.map((entry) =>
				this.fromSerializedEntry(entry),
			);
			this.redoStack = persisted.redoStack.map((entry) =>
				this.fromSerializedEntry(entry),
			);
			this.stateRevision += 1;
		} catch (error) {
			console.error("Failed to load command history:", error);
			this.history = [];
			this.redoStack = [];
			this.stateRevision += 1;
		} finally {
			this.notifyHistoryChange();
		}
	}

	async initializeEmptyHistory({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		this.releaseCanonical();
		this.activeProjectId = projectId;
		this.history = [];
		this.redoStack = [];
		this.stateRevision += 1;
		this.notifyHistoryChange();
		try {
			await storageService.saveCommandHistory({
				history: this.serializeHistory({ projectId }),
			});
		} catch (error) {
			console.error("Failed to initialize command history:", error);
		}
	}

	undo(): void {
		assertBatchEditable(this.editor.project.getActiveOrNull()?.metadata.id);
		if (this.canonical) {
			this.moveCanonicalHistory("undo");
			return;
		}
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		if (!entry) {
			return;
		}

		if (entry.command) {
			entry.command.undo();
		} else if (entry.beforeSnapshot) {
			this.restoreProjectSnapshot({ snapshot: entry.beforeSnapshot });
		}

		// Only restore selection for commands that explicitly changed it.
		// Commands without selection intent leave selection untouched,
		// preserving any UI-driven selection changes (clicks, box select)
		// that happened between commands. Commands that remove editor-owned
		// selection targets must declare a selection override to clear stale refs.
		if (entry.selectionOverride !== undefined) {
			this.editor.selection.restoreSnapshot({
				snapshot: entry.previousSelection,
			});
		}
		this.redoStack.push(entry);
		this.stateRevision += 1;
		this.persistHistory();
	}

	redo(): void {
		assertBatchEditable(this.editor.project.getActiveOrNull()?.metadata.id);
		if (this.canonical) {
			this.moveCanonicalHistory("redo");
			return;
		}
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		let selectionOverride = entry.selectionOverride;
		let afterSnapshot = entry.afterSnapshot;

		if (entry.command) {
			const result = entry.command.redo();
			this.applyRippleIfEnabled({ beforeTracks });
			selectionOverride = this.applySelectionOverride(result);
			this.runReactors();
			afterSnapshot = this.captureProjectSnapshot() ?? afterSnapshot;
		} else if (entry.afterSnapshot) {
			this.restoreProjectSnapshot({ snapshot: entry.afterSnapshot });
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.selectionOverride,
				});
			}
		}

		this.history.push({
			command: entry.command,
			previousSelection,
			selectionOverride,
			beforeSnapshot: entry.beforeSnapshot,
			afterSnapshot,
			beforeMedia: entry.beforeMedia,
			afterMedia: this.captureMediaBindings(),
		});
		this.stateRevision += 1;
		this.persistHistory();
	}

	canUndo(): boolean {
		if (this.canonical) return this.canonical.status().canUndo;
		return this.history.length > 0;
	}

	canRedo(): boolean {
		if (this.canonical) return this.canonical.status().canRedo;
		return this.redoStack.length > 0;
	}

	getStateRevision(): number {
		return this.stateRevision;
	}

	clear({ persist = true }: { persist?: boolean } = {}): void {
		this.canonical?.clearHistory();
		this.canonicalCallbacks.clear();
		this.history = [];
		this.redoStack = [];
		this.stateRevision += 1;
		if (persist) {
			this.persistHistory();
		} else {
			this.notifyHistoryChange();
		}
	}

	clearLoadedProject(): void {
		this.releaseCanonical();
		this.activeProjectId = null;
		this.clear({ persist: false });
	}

	async flushHistory(): Promise<void> {
		for (;;) {
			const pending = this.historySaveQueue;
			await pending;
			if (pending === this.historySaveQueue) return;
		}
	}

	/** Capture both opaque Rust protocols within one synchronous boundary. */
	captureEditingSession(): EditorSessionBundle {
		if (!this.canonical || this.transactionDepth !== 0)
			throw new Error(
				"Finish the canonical transaction before saving its session",
			);
		return {
			archive: this.canonical.archive(),
			agentCheckpoint: this.canonical.captureAgentCheckpoint(),
			thumbnail: this.editor.project.getActiveOrNull()?.metadata.thumbnail,
			conversation:
				this.canonical.readConversation(this.agentAccountId()) ?? undefined,
			artifacts: this.canonical.captureConversationArtifacts(
				this.agentAccountId(),
			),
		};
	}

	async persistEditingSession(): Promise<void> {
		const save = this.sessionPersistence;
		const session = this.canonical;
		if (!save || !session)
			throw new Error("Atomic session storage is not attached");
		const accountId = this.agentAccountId();
		if (
			this.scheduledSessionSave?.session === session &&
			this.scheduledSessionSave.accountId === accountId
		)
			return this.scheduledSessionSave.promise;
		// Capture at dispatch, so bursts share one pending save. Once capture
		// starts, newer edits get one subsequent save behind the in-flight write.
		const next = this.historySaveQueue
			.catch(() => undefined)
			.then(() =>
				save(() => {
					if (this.scheduledSessionSave?.promise === next)
						this.scheduledSessionSave = null;
					if (this.canonical !== session || this.agentAccountId() !== accountId)
						throw new Error(
							"The editor session changed before it could be saved",
						);
					return this.captureEditingSession();
				}),
			)
			.finally(() => {
				if (this.scheduledSessionSave?.promise === next)
					this.scheduledSessionSave = null;
			});
		this.scheduledSessionSave = { session, accountId, promise: next };
		this.historySaveQueue = next;
		await next;
	}

	hasAtomicSessionStorage(): boolean {
		return this.sessionPersistence !== null;
	}
	getEditingConversation():
		| import("@/core/agent-protocol").EditingConversationArchive
		| null {
		return this.canonical?.readConversation(this.agentAccountId()) ?? null;
	}
	setEditingInputAttachments(
		attachments: import("@/core/agent-protocol").EditingInputAttachment[],
	): void {
		if (!this.canonical)
			throw new Error("Open the canonical project before attaching inputs");
		this.canonical.setInputAttachments({
			accountId: this.agentAccountId(),
			attachments,
		});
	}
	storeEditingAttachment({
		bytes,
		mimeType,
		filename,
	}: {
		bytes: Uint8Array;
		mimeType: string;
		filename: string;
	}): import("@/core/agent-protocol").EditingInputAttachment {
		if (!this.canonical)
			throw new Error("Open the canonical project before attaching files");
		return this.canonical.storeInputAttachment({ bytes, mimeType, filename });
	}
	readEditingConversationArtifact(id: string): {
		bytes: Uint8Array;
		mimeType: string;
	} {
		if (!this.canonical)
			throw new Error("Open the canonical project before reading its artifact");
		return this.canonical.readConversationArtifact(id);
	}
	applyEditingConversation(
		event: import("@/core/agent-protocol").EditingConversationEvent,
	): import("@/core/agent-protocol").EditingConversationArchive {
		if (!this.canonical)
			throw new Error(
				"Open the canonical project before recording conversation",
			);
		return this.canonical.applyConversation({
			accountId: this.agentAccountId(),
			event,
		});
	}

	hasCanonicalHistory(): boolean {
		return this.canonical !== null || this.canonicalArchive !== null;
	}

	/** Project settings and preview gestures commit through the live registry. */
	updateClassicSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<import("@/project/types").TProjectSettings>;
		pushHistory?: boolean;
	}): boolean {
		// Legacy import commands replay host projections before canonical history
		// restores their saved boundary. They must not issue a second mutation.
		if (this.isProjectingCanonical) return false;
		if (!this.canonical)
			throw new Error(
				"Open the canonical editor before editing project settings",
			);
		assertBatchEditable(this.canonical.projectId);
		const nested = this.transactionDepth > 0;
		const keys = Object.keys(settings).sort().join(",");
		const previousGroup =
			this.settingsGesture?.keys === keys ? this.settingsGesture.id : undefined;
		const group = nested
			? undefined
			: (previousGroup ?? (!pushHistory ? generateUUID() : undefined));
		try {
			if (nested) this.synchronizeCanonicalViews();
			this.canonical.updateSettings({
				settings,
				...(group && { historyGroup: group }),
			});
			this.publishCanonical();
			this.stateRevision += 1;
			if (!nested) this.persistHistory();
			this.settingsGesture =
				!nested && !pushHistory && group ? { id: group, keys } : undefined;
			return true;
		} catch (error) {
			this.settingsGesture = undefined;
			throw error;
		}
	}

	createTextGraphics(input: {
		trackId: string;
		elementId: string;
		edge: "top" | "bottom";
	}): void {
		if (!this.canonical)
			throw new Error("Open the canonical editor before adding graphics");
		const sceneId = this.editor.scenes.getActiveScene().id;
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.invokeControl({
					capabilityId: "timeline.classic.text-graphics.create",
					input: { ...input, sceneId },
				});
				this.publishCanonical();
			},
		});
	}

	createPushBroll(input: {
		edge: "top" | "bottom";
		startTime: number;
		duration: number;
		screenPercent?: number;
		transitionSeconds?: number;
	}): void {
		if (!this.canonical)
			throw new Error("Open the canonical editor before adding B-roll");
		const sceneId = this.editor.scenes.getActiveScene().id;
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.invokeControl({
					capabilityId: "timeline.classic.push-broll.create",
					input: { ...input, sceneId },
				});
				this.publishCanonical();
			},
		});
	}

	editClassicScene(
		change: import("@/core/canonical-classic-session").ClassicSceneChange,
	): void {
		if (!this.canonical)
			throw new Error("Open the canonical editor before editing scenes");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.editScene(change);
				this.publishCanonical();
			},
		});
	}

	prepareSmartTakesForAutoEdit(): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before preparing takes");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.prepareTakesForAutoEdit({ sceneId });
				this.publishCanonical();
			},
		});
	}

	preparePodcast(elementIds: string[]) {
		const session = this.canonical;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!session || !sceneId || this.transactionDepth > 0)
			throw new Error("Open the editor before extracting podcast clips");
		this.synchronizeCanonicalViews();
		const account = this.agentAccountId();
		const source = session.preparePodcast({ sceneId, elementIds });
		const assertCurrent = () => {
			if (
				this.canonical !== session ||
				this.agentAccountId() !== account ||
				this.editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
				session.status().revision !== source.revision
			)
				throw new Error(
					"The source changed during analysis. Nothing was applied; analyze the episode again.",
				);
		};
		return {
			...source,
			review: ({
				options,
				videos,
			}: {
				options: import("@/ai/podcast-types").PodcastOptions;
				videos: import("@/ai/podcast-types").PodcastVideo[];
			}) => {
				assertCurrent();
				session.podcast({
					sceneId,
					elementIds,
					expectedRevision: source.revision,
					options,
					videos,
					review: true,
				});
			},
			analyzeAudio: (signal: AbortSignal) => {
				assertCurrent();
				return collectTakeAudioEvidence({
					editor: this.editor,
					elementIds,
					signal,
					boundedFrames: true,
				});
			},
			apply: (input: {
				options: import("@/ai/podcast-types").PodcastOptions;
				videos: import("@/ai/podcast-types").PodcastVideo[];
				audioEvidence: import("@/timeline/smart-takes/types").TakeAudioEvidence[];
			}) => {
				assertCurrent();
				this.executeTransaction({
					execute: () => {
						session.podcast({
							...input,
							sceneId,
							elementIds,
							expectedRevision: source.revision,
						});
						this.publishCanonical();
					},
				});
			},
		};
	}

	prepareSmartTakes(elementIds: string[]) {
		const session = this.canonical;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!session || !sceneId || this.transactionDepth > 0)
			throw new Error("Open the canonical editor before analyzing takes");
		this.synchronizeCanonicalViews();
		const account = this.agentAccountId();
		const prepared = session.prepareTakes({ sceneId, elementIds });
		return {
			...prepared,
			review: (
				input: Parameters<
					import("@/timeline/smart-takes/types").ReviewTakes
				>[0],
			) =>
				session.reviewTakes({
					...input,
					sceneId,
					elementIds,
					expectedRevision: prepared.revision,
				}),
			analyzeAudio: (signal: AbortSignal) =>
				collectTakeAudioEvidence({ editor: this.editor, elementIds, signal }),
			apply: ({
				plan,
				audioEvidence,
				execution,
			}: {
				plan: import("@/timeline/smart-takes/types").SmartTakePlan;
				audioEvidence?: import("@/timeline/smart-takes/types").TakeAudioEvidence[];
				execution?: {
					mode: import("@/timeline/smart-takes/types").SmartTakeMode;
					runMetrics: import("@/timeline/smart-takes/types").TakeRunMetrics;
				};
			}) => {
				if (
					this.canonical !== session ||
					this.agentAccountId() !== account ||
					this.editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
					session.status().revision !== prepared.revision
				)
					throw new Error(
						"The project changed during analysis. Nothing was applied; run Smart takes again.",
					);
				this.executeTransaction({
					execute: () => {
						session.editTakes({
							sceneId,
							change: {
								type: "assemble",
								elementIds,
								plan,
								audioEvidence,
								...execution,
							},
							expectedRevision: prepared.revision,
						});
						this.publishCanonical();
					},
				});
			},
		};
	}

	selectSmartTake({
		groupIndex,
		alternativeIndex,
	}: {
		groupIndex: number;
		alternativeIndex: number;
	}): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before selecting takes");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.editTakes({
					sceneId,
					change: {
						type: "select",
						groupIndex,
						alternativeIndex,
					},
				});
				this.publishCanonical();
			},
		});
	}

	editClassicBookmarks(input: {
		sceneId: string;
		change: import("@/core/canonical-classic-session").ClassicBookmarkChange;
	}): void {
		if (!this.canonical)
			throw new Error("Open the canonical editor before editing bookmarks");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.editBookmarks(input);
				this.publishCanonical();
			},
		});
	}

	/** Shared entry for declarative UI controls. Registry validation and the
	 * canonical transaction enforce schema, availability and atomic history. */
	invokeCanonicalControl({
		projectId,
		accountId,
		...action
	}: import("@/core/canonical-control").CanonicalControlAction & {
		projectId: string;
		accountId: string;
	}): unknown {
		if (
			!this.canonical ||
			this.canonical.projectId !== projectId ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			this.agentAccountId() !== accountId
		)
			throw new Error("The control's account or project changed");
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const result = this.canonical!.invokeControl(action);
				this.publishCanonical();
				return result;
			},
		});
	}

	/** The UI uses the same typed track contract discovered by the agent/MCP. */
	editClassicTrackLayout(
		change: import("@/core/canonical-classic-session").ClassicTrackLayoutChange,
	): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing track layout");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.editTrackLayout({ sceneId, change });
				this.publishCanonical();
			},
		});
	}

	updateClassicTrack(input: {
		trackId: string;
		change: import("@/core/canonical-classic-session").ClassicTrackChange;
	}): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before editing track controls",
			);
		this.executeTransaction({
			execute: () => {
				// Earlier commands in a compound action may have changed host views.
				this.synchronizeCanonicalViews();
				this.canonical!.updateTrack({ sceneId, ...input });
				this.publishCanonical();
			},
		});
	}
	editClassicElementControls(input: {
		elements: Array<{ trackId: string; elementId: string }>;
		change: import("@/core/canonical-classic-session").ClassicElementControlChange;
	}): void {
		if (!input.elements.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing clip controls");
		this.executeTransaction({
			execute: () => {
				const beforeTracks = this.editor.scenes.getActiveScene().tracks;
				this.synchronizeCanonicalViews();
				this.canonical!.editElementControls({ sceneId, ...input });
				this.publishCanonical();
				this.applyRippleIfEnabled({ beforeTracks });
				this.runReactors();
			},
		});
	}

	removeClassicTimelineContent(
		removal: import("@/core/canonical-classic-session").ClassicRemoval,
	): void {
		if (removal.type === "elements" && removal.elements.length === 0) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before removing timeline content",
			);
		this.executeTransaction({
			execute: () => {
				const beforeTracks = this.editor.scenes.getActiveScene().tracks;
				this.synchronizeCanonicalViews();
				this.canonical!.removeTimelineContent({ sceneId, removal });
				this.publishCanonical();
				// Explicit delete-and-close already spliced all layers in the Rust mutation.
				if (removal.type !== "elements" || !removal.ripple)
					this.applyRippleIfEnabled({ beforeTracks });
				if (removal.type === "elements")
					this.applySelectionOverride({
						selection: {
							selectedElements: [],
							selectedKeyframes: [],
							keyframeSelectionAnchor: null,
							selectedMaskPoints: null,
						},
					});
				this.runReactors();
			},
		});
	}

	prepareClassicMediaImport({
		projectId,
		assets,
		afterRegister,
	}: {
		projectId: string;
		assets: MediaAsset[];
		/** Synchronous canonical follow-up, grouped with registration in one Undo. */
		afterRegister?: () => undefined;
	}): () => void {
		const session = this.canonical;
		const expectedRevision = session?.status().revision;
		if (!session || expectedRevision === undefined)
			throw new Error("Open the canonical editor before importing media");
		const accountId =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		this.registerClassicMedia({
			projectId,
			assets,
			expectedRevision,
			dryRun: true,
		});
		return () => {
			if (
				this.canonical !== session ||
				(typeof window === "undefined" ? null : window.__opencutAccountId) !==
					accountId
			)
				throw new Error(
					"Media import account or editor session changed before publication",
				);
			this.executeTransaction({
				execute: () => {
					this.registerClassicMedia({ projectId, assets, expectedRevision });
					afterRegister?.();
				},
			});
		};
	}

	registerClassicMedia({
		projectId,
		assets,
		expectedRevision,
		dryRun = false,
	}: {
		projectId: string;
		assets: MediaAsset[];
		expectedRevision: number;
		dryRun?: boolean;
	}): void {
		assertBatchEditable(projectId);
		if (
			!this.canonical ||
			this.canonical.projectId !== projectId ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			throw new Error(
				"Open the canonical target project before registering media",
			);
		if (dryRun) {
			this.canonical.registerMedia({
				assets: canonicalMediaBindings(assets),
				expectedRevision,
				dryRun,
			});
			return;
		}
		this.executeTransaction({
			execute: () => {
				this.canonical!.registerMedia({
					assets: canonicalMediaBindings(assets),
					expectedRevision,
				});
				for (const asset of assets)
					this.canonicalMediaHandles.set(asset.id, asset);
				this.publishCanonical();
				this.runReactors();
			},
		});
	}

	removeClassicMedia({
		projectId,
		mediaIds,
	}: {
		projectId: string;
		mediaIds: string[];
	}): void {
		if (!mediaIds.length) return;
		if (!this.canonical || this.canonical.projectId !== projectId)
			throw new Error(
				"Open the canonical target project before removing media",
			);
		this.executeTransaction({
			execute: () => {
				const beforeTracks = this.editor.scenes.getActiveScene().tracks;
				this.synchronizeCanonicalViews();
				this.canonical!.removeMedia({ mediaIds, cascade: true });
				this.publishCanonical();
				this.applyRippleIfEnabled({ beforeTracks });
				this.applySelectionOverride({
					selection: {
						selectedElements: [],
						selectedTextWords: [],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
			},
		});
	}

	duplicateClassicTimelineElements(
		elements: Array<{ trackId: string; elementId: string }>,
	): Array<{ trackId: string; elementId: string }> {
		if (elements.length === 0) return [];
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before duplicating timeline content",
			);
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const copies = this.canonical!.duplicateTimelineElements({
					sceneId,
					elements,
				});
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: copies,
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
				return copies;
			},
		});
	}

	mergeClassicTextElements(input: {
		elements: Array<{ trackId: string; elementId: string }>;
		mode?: "single-line" | "multiline";
	}): void {
		if (input.elements.length < 2) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before merging text");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const target = this.canonical!.mergeTextElements({ ...input, sceneId });
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: [target],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
			},
		});
	}

	copyClassicTimelineElements(
		elements: Array<{ trackId: string; elementId: string }>,
	): {
		sourceProjectId: string;
		items: import("@/clipboard").ElementClipboardItem[];
	} {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before copying clips");
		if (this.transactionDepth > 0) this.synchronizeCanonicalViews();
		return this.canonical.copyTimelineElements({ sceneId, elements });
	}

	pasteClassicTimelineElements(input: {
		time: import("@/wasm").MediaTime;
		sourceProjectId?: string;
		items: import("@/clipboard").ElementClipboardItem[];
	}): boolean {
		if (!input.items.length) return false;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before pasting clips");
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const elements = this.canonical!.pasteTimelineElements({
					...input,
					sceneId,
					sourceProjectId: input.sourceProjectId ?? this.canonical!.projectId,
				});
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: elements,
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
				return elements.length > 0;
			},
		});
	}

	splitClassicTimelineElements(input: {
		elements: Array<{ trackId: string; elementId: string }>;
		splitTime: import("@/wasm").MediaTime;
		retainSide: "both" | "left" | "right";
	}): Array<{ trackId: string; elementId: string }> {
		if (!input.elements.length) return [];
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before splitting clips");
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const right = this.canonical!.splitTimelineElements({
					...input,
					sceneId,
				});
				this.publishCanonical();
				if (right.length)
					this.applySelectionOverride({
						selection: {
							selectedElements: right,
							selectedKeyframes: [],
							keyframeSelectionAnchor: null,
							selectedMaskPoints: null,
						},
					});
				this.runReactors();
				return right;
			},
		});
	}

	getCanonicalRevision(): number | undefined {
		return this.canonical?.status().revision;
	}
	setClassicBackgroundRemoval(input: {
		trackId: string;
		elementId: string;
		settings: import("@/background-removal").BackgroundRemovalSettings;
		duplicate: boolean;
	}): { trackId: string; elementId: string } {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before configuring background removal",
			);
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const target = this.canonical!.setBackgroundRemoval({
					...input,
					sceneId,
				});
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: [target],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
				return target;
			},
		});
	}
	applyClassicTransitions({
		applications,
		managedTextSfx = false,
	}: {
		applications: import("@/core/canonical-classic-session").ClassicTransitionApplication[];
		managedTextSfx?: boolean;
	}): void {
		if (!applications.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before applying transitions");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.applyTransitions({
					sceneId,
					applications,
					managedTextSfx,
				});
				this.publishCanonical();
				this.runReactors();
			},
		});
	}

	private clipUpdateGesture?: { id: string; target: string };
	updateClassicTimelineElements({
		updates,
		pushHistory = true,
		managedTypingSfx,
	}: {
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<import("@/timeline").TimelineElement>;
		}>;
		pushHistory?: boolean;
		managedTypingSfx?: boolean;
	}): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before updating clips");
		assertBatchEditable(this.canonical.projectId);
		const nested = this.transactionDepth > 0;
		if (pushHistory && !nested && !this.clipUpdateGesture) {
			this.executeTransaction({
				execute: () =>
					this.updateClassicTimelineElements({
						updates,
						pushHistory: false,
						managedTypingSfx,
					}),
			});
			return;
		}
		const target = JSON.stringify([
			sceneId,
			updates.map((update) => [
				update.trackId,
				update.elementId,
				Object.keys(update.patch).sort(),
				Object.keys(update.patch.params ?? {}).sort(),
			]),
		]);
		const group = !nested
			? this.clipUpdateGesture?.target === target
				? this.clipUpdateGesture.id
				: !pushHistory
					? generateUUID()
					: undefined
			: undefined;
		try {
			if (nested) this.synchronizeCanonicalViews();
			this.canonical.updateTimelineElements({
				sceneId,
				updates,
				...(managedTypingSfx !== undefined && { managedTypingSfx }),
				...(group && { historyGroup: group }),
			});
			this.publishCanonical();
			this.stateRevision += 1;
			this.runReactors();
			if (!nested) this.persistHistory();
			this.clipUpdateGesture =
				!nested && !pushHistory && group ? { id: group, target } : undefined;
		} catch (error) {
			this.clipUpdateGesture = undefined;
			throw error;
		}
	}
	moveClassicTimelineElements({
		moves,
		createTracks,
	}: {
		moves: import("@/timeline/group-move").PlannedElementMove[];
		createTracks?: import("@/timeline/group-move").PlannedTrackCreation[];
	}): void {
		if (!moves.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before moving timeline content",
			);
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const refs = this.canonical!.moveTimelineElements({
					sceneId,
					moves,
					createTracks,
				});
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: refs,
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
			},
		});
	}

	insertClassicTimelineElements(
		clips: import("@/commands/timeline/element/insert-element").InsertElementParams[],
	): Array<{ trackId: string; elementId: string }> {
		if (!clips.length) return [];
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error(
				"Open the canonical editor before inserting timeline content",
			);
		return this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				const refs = this.canonical!.insertTimelineElements({ sceneId, clips });
				this.publishCanonical();
				this.applySelectionOverride({
					selection: {
						selectedElements: [refs[refs.length - 1]],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				this.runReactors();
				return refs;
			},
		});
	}

	prepareClassicKeyframeEdit(): (
		edits: import("@/core/canonical-classic-session").ClassicKeyframeEdit[],
	) => void {
		const session = this.canonical;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!session || !sceneId || this.transactionDepth > 0)
			throw new Error(
				"Open the editor outside a transaction before dragging keyframes",
			);
		const revision = session.status().revision;
		const accountId = this.agentAccountId();
		return (edits) => {
			if (
				this.canonical !== session ||
				this.agentAccountId() !== accountId ||
				this.editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
				session.status().revision !== revision
			)
				throw new Error(
					"The editor changed during the keyframe drag; start the adjustment again",
				);
			this.editClassicKeyframes({ edits });
		};
	}

	editClassicKeyframes({
		edits,
	}: {
		edits: import("@/core/canonical-classic-session").ClassicKeyframeEdit[];
	}): void {
		if (!edits.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing keyframes");
		const nested = this.transactionDepth > 0;
		this.executeTransaction({
			execute: () => {
				if (nested) this.synchronizeCanonicalViews();
				this.canonical!.editKeyframes({ sceneId, edits });
				this.publishCanonical();
			},
		});
	}

	upsertClassicKeyframes({
		keyframes,
	}: {
		keyframes: import("@/core/canonical-classic-session").ClassicKeyframeUpsert[];
	}): void {
		if (!keyframes.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before creating keyframes");
		const nested = this.transactionDepth > 0;
		this.executeTransaction({
			execute: () => {
				if (nested) this.synchronizeCanonicalViews();
				this.canonical!.upsertKeyframes({ sceneId, keyframes });
				this.publishCanonical();
			},
		});
	}

	copyClassicKeyframes(input: {
		trackId: string;
		elementId: string;
		keyframes: Array<{ propertyPath: string; keyframeId: string }>;
	}): import("@/clipboard").KeyframeClipboardItem[] {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before copying keyframes");
		if (this.transactionDepth > 0) this.synchronizeCanonicalViews();
		return this.canonical.copyKeyframes({ sceneId, ...input }).items;
	}

	pasteClassicKeyframes(input: {
		trackId: string;
		elementId: string;
		time: number;
		items: import("@/clipboard").KeyframeClipboardItem[];
	}): boolean {
		if (!input.items.length) return false;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before pasting keyframes");
		const nested = this.transactionDepth > 0;
		let pasted = false;
		this.executeTransaction({
			execute: () => {
				if (nested) this.synchronizeCanonicalViews();
				pasted =
					this.canonical!.pasteKeyframes({ sceneId, ...input }).keyframes
						.length > 0;
				this.publishCanonical();
			},
		});
		return pasted;
	}

	removeClassicKeyframes({
		keyframes,
		playheadTime,
		preserveAtPlayhead,
	}: {
		keyframes: import("@/core/canonical-classic-session").ClassicKeyframeRemoval[];
		playheadTime: number;
		preserveAtPlayhead: boolean;
	}): void {
		if (!keyframes.length) return;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before removing keyframes");
		const nested = this.transactionDepth > 0;
		this.executeTransaction({
			execute: () => {
				if (nested) this.synchronizeCanonicalViews();
				this.canonical!.removeKeyframes({
					sceneId,
					keyframes,
					playheadTime,
					preserveAtPlayhead,
				});
				this.publishCanonical();
			},
		});
	}

	editClassicSourceAudio(
		input: import("@/core/canonical-classic-session").ClassicSourceAudioChange,
	): void {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing source audio");
		this.executeTransaction({
			execute: () => {
				this.synchronizeCanonicalViews();
				this.canonical!.editSourceAudio({ sceneId, ...input });
				this.publishCanonical();
			},
		});
	}

	previewClassicMask(input: {
		trackId: string;
		elementId: string;
		maskId?: string;
		change: import("@/core/canonical-classic-session").ClassicMaskChange;
	}): import("@/masks/types").Mask[] {
		const session = this.canonical;
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!session || !sceneId || this.transactionDepth > 0)
			throw new Error(
				"Open the editor outside a transaction before previewing masks",
			);
		assertBatchEditable(session.projectId);
		const previous = this.maskPreview;
		const sameTarget =
			previous?.session === session &&
			previous.request.sceneId === sceneId &&
			previous.request.trackId === input.trackId &&
			previous.request.elementId === input.elementId &&
			previous.request.maskId === input.maskId &&
			previous.request.change.type === input.change.type;
		const request = {
			...input,
			sceneId,
			expectedRevision: sameTarget
				? previous.request.expectedRevision
				: session.status().revision,
			catalogRevision: sameTarget
				? previous.request.catalogRevision
				: session.maskCatalogRevision(),
		};
		if (
			sameTarget &&
			previous.request.change.type === "update" &&
			input.change.type === "update"
		)
			request.change = {
				type: "update",
				params: { ...previous.request.change.params, ...input.change.params },
			};
		try {
			if (sameTarget && previous.accountId !== this.agentAccountId())
				throw new Error("Mask preview account changed");
			const result = session.editMask({ ...request, dryRun: true });
			this.maskPreview = { session, accountId: this.agentAccountId(), request };
			return result.masks;
		} catch (error) {
			this.maskPreview = null;
			throw error;
		}
	}

	hasClassicMaskPreview(): boolean {
		return this.maskPreview !== null;
	}
	discardClassicMaskPreview(): void {
		this.maskPreview = null;
	}
	commitClassicMaskPreview(): void {
		const prepared = this.maskPreview;
		this.maskPreview = null;
		if (!prepared) return;
		if (
			prepared.session !== this.canonical ||
			prepared.accountId !== this.agentAccountId() ||
			prepared.request.sceneId !== this.editor.scenes.getActiveSceneOrNull()?.id
		)
			throw new Error("Mask preview editor, account or scene changed");
		this.editClassicMask(prepared.request);
	}

	editClassicMask(input: {
		trackId: string;
		elementId: string;
		maskId?: string;
		sceneId?: string;
		expectedRevision?: number;
		catalogRevision?: string;
		change: import("@/core/canonical-classic-session").ClassicMaskChange;
	}): { insertedPointId: string | null; removedPointIds: string[] } {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing masks");
		if (input.sceneId && input.sceneId !== sceneId)
			throw new Error("Mask target scene is not active");
		const nested = this.transactionDepth > 0;
		return this.executeTransaction({
			execute: () => {
				// Only preceding legacy commands in a compound action need adoption.
				// A standalone preview must keep the revision it was prepared against.
				if (nested) this.synchronizeCanonicalViews();
				const result = this.canonical!.editMask({ sceneId, ...input });
				this.publishCanonical();
				if (result.insertedPointId && input.maskId)
					this.applySelectionOverride({
						selection: {
							selectedMaskPoints: {
								trackId: input.trackId,
								elementId: input.elementId,
								maskId: input.maskId,
								pointIds: [result.insertedPointId],
							},
						},
					});
				else if (result.removedPointIds.length > 0)
					this.applySelectionOverride({
						selection: { selectedMaskPoints: null },
					});
				return result;
			},
		});
	}

	editClassicEffects({
		trackId,
		elementId,
		change,
		pushHistory = true,
	}: {
		trackId: string;
		elementId: string;
		change: import("@/core/canonical-classic-session").ClassicEffectChange;
		pushHistory?: boolean;
	}): string | null {
		const sceneId = this.editor.scenes.getActiveSceneOrNull()?.id;
		if (!this.canonical || !sceneId)
			throw new Error("Open the canonical editor before editing effects");
		assertBatchEditable(this.canonical.projectId);
		const nested = this.transactionDepth > 0;
		const target = JSON.stringify([
			sceneId,
			trackId,
			elementId,
			change.type,
			change.type === "update"
				? [change.effectId, Object.keys(change.params).sort()]
				: null,
		]);
		const group =
			!nested && change.type === "update"
				? this.effectGesture?.target === target
					? this.effectGesture.id
					: !pushHistory
						? generateUUID()
						: undefined
				: undefined;
		try {
			if (nested) this.synchronizeCanonicalViews();
			const result = this.canonical.editEffects({
				sceneId,
				trackId,
				elementId,
				change,
				...(group && { historyGroup: group }),
			});
			this.publishCanonical();
			this.stateRevision += 1;
			if (!nested) this.persistHistory();
			this.effectGesture =
				!nested && !pushHistory && group ? { id: group, target } : undefined;
			return result.effectId;
		} catch (error) {
			this.effectGesture = undefined;
			throw error;
		}
	}

	async startEditingAgent({
		runId,
		request,
	}: {
		runId: string;
		request: string;
	}): Promise<EditingAgentSnapshot> {
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		const accountId = this.agentAccountId();
		await this.enableCanonical();
		if (
			!projectId ||
			this.canonical?.projectId !== projectId ||
			this.agentAccountId() !== accountId
		)
			throw new Error("The editing agent's account or project changed");
		return this.canonical.startAgent({ accountId, runId, request });
	}

	getEditingAgentSnapshot(): EditingAgentSnapshot | null {
		const state = this.canonical?.agentSnapshot() ?? null;
		if (
			state &&
			(state.scope.accountId !== this.agentAccountId() ||
				state.scope.projectId !==
					this.editor.project.getActiveOrNull()?.metadata.id)
		)
			throw new Error(
				"The editing agent belongs to another account or project",
			);
		return state;
	}

	/** All feature calls go through Rust's live capability contracts. Project
	 * views are published only after the canonical operation has committed. */
	executeEditingAgentCommand(command: EditingAgentCommand): unknown {
		return this.publishEditingAgentEffect({
			execute: () => this.canonical!.agentCommand(command),
			mayWrite: command.type === "invoke",
		});
	}

	getEditingAgentModelSchema(): unknown {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent in the active project first");
		return this.canonical.agentModelSchema();
	}

	prepareEditingAgentRequest(model: string): EditingAgentProviderRequest {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.agentProviderRequest(model);
	}
	loadEditingAgentKnowledge(context: unknown): void {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		this.canonical.loadAgentKnowledge({
			accountId: this.agentAccountId(),
			context,
		});
	}

	getEditingAgentHostEffect():
		| import("@/core/agent-protocol").EditingAgentHostEffect
		| null {
		if (!this.canonical || !this.getEditingAgentSnapshot()) return null;
		return this.canonical.agentPendingHost();
	}
	settleEditingAgentHostEffect({
		effectId,
		result,
	}: {
		effectId: number;
		result: import("@/core/agent-protocol").EditingAgentHostResult;
	}): EditingAgentProviderRound {
		// A committed receipt must still be accepted while paused or after the
		// background lock changed. It cannot itself initiate another write.
		return this.publishEditingAgentEffect({
			execute: () =>
				this.canonical!.agentSettleHost({
					accountId: this.agentAccountId(),
					effectId,
					result,
				}),
			mayWrite: false,
		});
	}

	prepareEditingAgentReview(): EditingAgentReviewPlan {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.agentReviewPlan();
	}
	prepareEditingAgentReviewRequest(
		input: EditingAgentReviewRequest,
	): EditingAgentProviderRequest {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.agentReviewRequest(input);
	}
	applyEditingAgentReview(input: {
		epoch: number;
		response: unknown;
	}): EditingAgentReviewResult {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.agentReviewResponse(input);
	}
	storeEditingAgentFrame(bytes: Uint8Array): { id: string } {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.storeAgentFrame(bytes);
	}
	storeEditingAgentRender(input: { bytes: Uint8Array; mimeType: string }): {
		id: string;
	} {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.storeAgentRender(input);
	}
	storeEditingAgentImage(input: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}): unknown {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.storeAgentImage(input);
	}
	storeEditingAgentScreenshot(capture: {
		bytes: Uint8Array;
		width: number;
		height: number;
	}): unknown {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent first");
		return this.canonical.storeAgentScreenshot(capture);
	}

	applyEditingAgentResponse(input: {
		epoch: number;
		response: unknown;
	}): EditingAgentProviderRound {
		return this.publishEditingAgentEffect({
			execute: () => this.canonical!.agentProviderResponse(input),
			mayWrite: true,
		});
	}

	executeEditingAgentModelAction(input: {
		epoch: number;
		callId: string;
		action: unknown;
	}): unknown {
		return this.publishEditingAgentEffect({
			execute: () => this.canonical!.agentModelAction(input),
			mayWrite: true,
		});
	}

	private publishEditingAgentEffect<T>({
		execute,
		mayWrite,
	}: {
		execute: () => T;
		mayWrite: boolean;
	}): T {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent in the active project first");
		if (mayWrite) assertBatchEditable(this.canonical.projectId);
		const revision = this.canonical.status().revision;
		try {
			return execute();
		} finally {
			if (this.canonical.status().revision !== revision) {
				this.publishCanonical();
				this.stateRevision += 1;
				this.editor.save.markDirty();
				this.persistHistory();
			}
		}
	}

	/** Called by the renderer QA host after inspection, never by model tools. */
	verifyEditingAgent(input: {
		epoch: number;
		revision: number;
		issues: string[];
	}): void {
		if (!this.canonical || !this.getEditingAgentSnapshot())
			throw new Error("Start an editing agent in the active project first");
		this.canonical.verifyAgent(input);
	}

	private agentAccountId(): string {
		return (
			(typeof window === "undefined" ? null : window.__opencutAccountId) ??
			"local"
		);
	}
	detachCanonical(): void {
		this.releaseCanonical();
		this.notifyHistoryChange();
	}

	async enableCanonical({
		runtime,
		atomicBundle,
		persistSession,
		persistInitial = true,
	}: {
		runtime?: CanonicalEditorRuntime;
		atomicBundle?: EditorSessionBundle;
		persistSession?: (capture: () => EditorSessionBundle) => Promise<void>;
		persistInitial?: boolean;
	} = {}): Promise<void> {
		if (atomicBundle && !persistSession)
			throw new Error(
				"Restoring an atomic session requires its storage adapter",
			);
		if (this.canonical && (atomicBundle || persistSession))
			throw new Error(
				"Close the current canonical session before attaching a saved session",
			);
		if (this.canonical) return;
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		const accountId = this.agentAccountId();
		if (!projectId)
			throw new Error("Open a project before attaching its runtime");
		const { effectsRegistry, registerDefaultEffects } =
			await import("@/effects");
		const { masksRegistry, registerDefaultMasks } = await import("@/masks");
		const { bindProductAnimationCatalog } =
			await import("@/animation/product-catalog");
		const binding = runtime ?? (await loadCanonicalRuntime());
		if (this.canonical) {
			binding.free();
			return;
		}
		if (
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			this.agentAccountId() !== accountId
		) {
			binding.free();
			throw new Error("The active project changed while loading its runtime");
		}
		const session = new CanonicalClassicSession({
			runtime: binding,
			projectId,
		});
		try {
			const classic = this.canonicalView();
			if (
				typeof window !== "undefined" &&
				window.opencutElectron?.captureEditorScreenshot
			)
				binding.installDesktopUi();
			registerDefaultEffects();
			session.setEffectCatalog(effectsRegistry.catalog());
			registerDefaultMasks();
			session.setMaskCatalog(masksRegistry.catalog());
			this.unsubscribeAnimationCatalog = bindProductAnimationCatalog((groups) =>
				session.setAnimationCatalog(groups),
			);
			if (atomicBundle) {
				session.restore(atomicBundle.archive);
				if (atomicBundle.artifacts)
					session.restoreConversationArtifacts({
						accountId,
						archive: atomicBundle.artifacts,
					});
				if (atomicBundle.conversation)
					session.restoreConversation({
						accountId,
						archive: atomicBundle.conversation,
					});
				if (atomicBundle.agentCheckpoint)
					session.restoreAgentCheckpoint({
						accountId,
						checkpoint: atomicBundle.agentCheckpoint,
					});
			} else if (this.canonicalArchive) {
				session.restore(this.canonicalArchive);
				// Project and history use separate durable records. The loaded project
				// remains current while the saved undo boundaries are retained.
				session.synchronize({ classic });
			} else {
				const convert = ({
					entry,
					direction,
				}: {
					entry: CommandHistoryEntry;
					direction: "undo" | "redo";
				}): CanonicalHistoryBoundary => {
					const document =
						direction === "undo" ? entry.beforeSnapshot : entry.afterSnapshot;
					if (!document)
						throw new Error(
							"An existing undo action has no project snapshot; its history was preserved",
						);
					const callbackId = entry.command ? generateUUID() : undefined;
					const command = entry.command;
					if (callbackId && command)
						this.canonicalCallbacks.set(callbackId, {
							undo: () => command.undo(),
							redo: () => command.redo(),
						});
					return {
						label: command?.constructor.name || "Existing edit",
						classic: {
							document,
							mediaAssets:
								(direction === "undo" ? entry.beforeMedia : entry.afterMedia) ??
								classic.mediaAssets,
						},
						hostContext: {
							previousSelection: entry.previousSelection,
							persistable: command?.canPersistHistory ?? true,
							...(callbackId && { callbackId }),
							...(entry.selectionOverride !== undefined && {
								selectionOverride: entry.selectionOverride,
							}),
						},
					};
				};
				session.attach({
					classic,
					undoStack: this.history.map((entry) =>
						convert({ entry, direction: "undo" }),
					),
					redoStack: this.redoStack.map((entry) =>
						convert({ entry, direction: "redo" }),
					),
				});
			}
			this.canonical = session;
			this.unsubscribeEffectCatalog = effectsRegistry.subscribe((definitions) =>
				session.setEffectCatalog(definitions),
			);
			this.unsubscribeMaskCatalog = masksRegistry.subscribe((definitions) =>
				session.setMaskCatalog(definitions),
			);
			this.sessionPersistence = persistSession ?? null;
			this.canonicalArchive = null;
			this.history = [];
			this.redoStack = [];
			this.stateRevision += 1;
			if (atomicBundle) this.publishCanonical();
		} catch (error) {
			if (this.canonical === session) this.canonical = null;
			this.unsubscribeEffectCatalog?.();
			this.unsubscribeEffectCatalog = null;
			this.unsubscribeMaskCatalog?.();
			this.unsubscribeMaskCatalog = null;
			this.unsubscribeAnimationCatalog?.();
			this.unsubscribeAnimationCatalog = null;
			this.sessionPersistence = null;
			session.dispose();
			this.canonicalCallbacks.clear();
			throw error;
		}
		// An atomic restore is already durable. Rewriting its entire undo archive
		// during open can time out before a background resume even starts.
		if (persistInitial && !atomicBundle) this.persistHistory();
		else this.notifyHistoryChange();
	}

	/** ProjectManager publishes this view only after canonical validation succeeds. */
	synchronizeProject(project: TProject | null): void {
		if (!this.canonical || this.isProjectingCanonical) return;
		if (this.silenceCommit) {
			if (!project || project.metadata.id !== this.canonical.projectId)
				throw new Error("The silence edit project changed");
			this.canonical.commitSilence({
				...this.silenceCommit,
				idempotencyKey: generateUUID(),
				classic: {
					document: this.snapshotOfProject({ project, scenes: project.scenes }),
					mediaAssets: this.captureMediaBindings(),
				},
			});
			this.stateRevision += 1;
			return;
		}
		if (!project || project.metadata.id !== this.canonical.projectId) {
			this.releaseCanonical();
			return;
		}
		this.canonical.synchronize({
			classic: {
				document: this.snapshotOfProject({ project, scenes: project.scenes }),
				mediaAssets: this.captureMediaBindings(),
			},
		});
		this.stateRevision += 1;
	}

	synchronizeMedia({
		assets,
		dryRun = false,
	}: {
		assets: MediaAsset[];
		dryRun?: boolean;
	}): void {
		if (!this.canonical || this.isProjectingCanonical) return;
		if (this.silenceCommit)
			throw new Error("Silence edits cannot change media bindings");
		this.canonical.synchronize({
			classic: {
				...this.canonical.read(),
				mediaAssets: canonicalMediaBindings(assets),
			},
			dryRun,
		});
		if (!dryRun) this.stateRevision += 1;
	}

	async readHyperframesLibrary({ projectId }: { projectId: string }) {
		const accountId =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		await this.enableCanonical();
		if (
			!this.canonical ||
			this.canonical.projectId !== projectId ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			(typeof window === "undefined" ? null : window.__opencutAccountId) !==
				accountId
		)
			throw new Error("The HyperFrames library project changed");
		return this.canonical.readHyperframesLibrary();
	}

	async searchHyperframesExamples(
		input: Parameters<
			CanonicalClassicSession["searchHyperframesExamples"]
		>[0] & { projectId: string; semantic?: boolean; signal?: AbortSignal },
	) {
		await this.readHyperframesLibrary({ projectId: input.projectId });
		const {
			projectId,
			semantic,
			signal = new AbortController().signal,
			...query
		} = input;
		const session = this.canonical!;
		const accountId =
			typeof window === "undefined"
				? "local"
				: (window.__opencutAccountId ?? "local");
		const check = () => {
			signal.throwIfAborted();
			if (
				this.canonical !== session ||
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				(typeof window === "undefined"
					? "local"
					: (window.__opencutAccountId ?? "local")) !== accountId
			)
				throw new Error("Reference search account or project changed");
		};
		check();
		let fallbackReason: string | undefined;
		if (semantic && query.query.trim() && !query.embedding) {
			try {
				const { performHostEffect } =
					await import("@/editor-agent/host-effects");
				query.embedding = await session.embedHyperframesQuery({
					query: query.query,
					host: async (effect) => {
						check();
						return performHostEffect({ effect, accountId, signal });
					},
				});
			} catch (error) {
				check();
				fallbackReason =
					error instanceof Error
						? error.message
						: "Local semantic search unavailable";
			}
		}
		check();
		return {
			...session.searchHyperframesExamples(query),
			...(fallbackReason ? { fallbackReason } : {}),
		};
	}

	async readHyperframesExample(input: {
		projectId: string;
		id: string;
		upstreamCommit: string;
	}) {
		await this.readHyperframesLibrary({ projectId: input.projectId });
		const { projectId: _projectId, ...reference } = input;
		return this.canonical!.readHyperframesExample(reference);
	}

	async readHyperframesExampleSource(
		input: Parameters<
			CanonicalClassicSession["readHyperframesExampleSource"]
		>[0]["input"] & { projectId: string; signal: AbortSignal },
	) {
		const accountId =
			typeof window === "undefined"
				? "local"
				: (window.__opencutAccountId ?? "local");
		await this.readHyperframesLibrary({ projectId: input.projectId });
		const session = this.canonical!;
		const { projectId, signal, ...reference } = input;
		const { performHostEffect } = await import("@/editor-agent/host-effects");
		const assertScope = () => {
			signal.throwIfAborted();
			if (
				this.canonical !== session ||
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				(typeof window === "undefined"
					? "local"
					: (window.__opencutAccountId ?? "local")) !== accountId
			)
				throw new Error("Reference read account or project changed");
		};
		assertScope();
		const page = await session.readHyperframesExampleSource({
			input: reference,
			host: async (effect) => {
				assertScope();
				return performHostEffect({ effect, accountId, signal });
			},
		});
		assertScope();
		return page;
	}

	async insertHyperframes(
		input: Parameters<CanonicalClassicSession["insertHyperframes"]>[0] & {
			projectId: string;
		},
	) {
		const { projectId, ...request } = input;
		const accountId =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		const checkTarget = () => {
			assertBatchEditable(projectId);
			if (
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				this.editor.scenes.getActiveSceneOrNull()?.id !== request.sceneId ||
				(typeof window === "undefined" ? null : window.__opencutAccountId) !==
					accountId
			)
				throw new Error("The target project, account or scene changed");
		};
		checkTarget();
		await this.enableCanonical();
		checkTarget();
		return this.executeTransaction({
			execute: () => {
				if (!this.canonical || this.canonical.projectId !== projectId)
					throw new Error("The canonical project was closed");
				const inserted = this.canonical.insertHyperframes(request);
				this.publishCanonical();
				this.editor.selection.applySelectionPatch({
					patch: {
						selectedElements: [
							{ trackId: inserted.trackId, elementId: inserted.itemId },
						],
						selectedTextWords: [],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				return inserted;
			},
		});
	}

	async readHyperframesAudioClips({
		projectId,
		sceneId,
	}: {
		projectId: string;
		sceneId: string;
	}) {
		await this.enableCanonical();
		if (
			!this.canonical ||
			this.canonical.projectId !== projectId ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			throw new Error("The HyperFrames audio project changed");
		return this.canonical.readHyperframesAudioClips({ sceneId });
	}

	async readHyperframesLayerRows({
		projectId,
		...input
	}: {
		projectId: string;
		sceneId: string;
		elementId: string;
	}) {
		await this.enableCanonical();
		if (
			!this.canonical ||
			this.canonical.projectId !== projectId ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId
		)
			throw new Error("The HyperFrames layer project changed");
		return this.canonical.readHyperframesLayerRows(input);
	}

	async importHyperframes(
		input: Parameters<CanonicalClassicSession["importHyperframes"]>[0] & {
			target?: { projectId: string; sceneId: string; signal?: AbortSignal };
			dryRun?: boolean;
		},
	) {
		const { target, dryRun = false, ...request } = input;
		target?.signal?.throwIfAborted();
		const projectId =
			target?.projectId ?? this.editor.project.getActiveOrNull()?.metadata.id;
		assertBatchEditable(projectId);
		if (this.editor.project.getActiveOrNull()?.metadata.id !== projectId)
			throw new Error("The target project is no longer active");
		await this.enableCanonical();
		target?.signal?.throwIfAborted();
		if (this.editor.project.getActiveOrNull()?.metadata.id !== projectId)
			throw new Error("The active project changed while preparing the import");
		if (
			target &&
			this.editor.scenes.getActiveSceneOrNull()?.id !== target.sceneId
		)
			throw new Error("The active scene changed while preparing the import");
		if (dryRun) {
			if (!this.canonical) throw new Error("The canonical project was closed");
			return this.canonical.previewHyperframesImport(request);
		}
		return this.executeTransaction({
			retainMediaResources: true,
			execute: () => {
				if (!this.canonical)
					throw new Error("The canonical project was closed");
				const imported = this.canonical.importHyperframes(request);
				this.publishCanonical();
				this.editor.selection.applySelectionPatch({
					patch: {
						selectedElements: [
							{ trackId: imported.trackId, elementId: imported.itemId },
						],
						selectedTextWords: [],
						selectedKeyframes: [],
						keyframeSelectionAnchor: null,
						selectedMaskPoints: null,
					},
				});
				return imported;
			},
		});
	}

	async setHyperframesLayerOpacity(
		input: Parameters<
			CanonicalClassicSession["setHyperframesLayerOpacity"]
		>[0] & { projectId: string; signal?: AbortSignal },
	): Promise<void> {
		const { projectId, signal, ...request } = input;
		const accountId = window.__opencutAccountId;
		const checkTarget = () => {
			signal?.throwIfAborted();
			assertBatchEditable(projectId);
			if (
				window.__opencutAccountId !== accountId ||
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				this.editor.scenes.getActiveSceneOrNull()?.id !== request.sceneId
			)
				throw new Error("The target project, account or scene changed");
		};
		checkTarget();
		await this.enableCanonical();
		checkTarget();
		this.executeTransaction({
			execute: () => {
				if (!this.canonical || this.canonical.projectId !== projectId)
					throw new Error("The canonical project was closed");
				this.canonical.setHyperframesLayerOpacity(request);
				this.publishCanonical();
			},
		});
	}

	async setHyperframesVariables(input: {
		projectId: string;
		sceneId: string;
		elementId: string;
		source: import("@/hyperframes/types").HyperframesSource;
		values: Record<string, unknown>;
		signal: AbortSignal;
	}): Promise<void> {
		return this.applyHyperframesSourceEdit({ ...input, kind: "variables" });
	}

	async setHyperframesSource(input: {
		projectId: string;
		sceneId: string;
		elementId: string;
		source: import("@/hyperframes/types").HyperframesSource;
		changes: Record<string, string | null>;
		signal: AbortSignal;
	}): Promise<void> {
		return this.applyHyperframesSourceEdit({ ...input, kind: "files" });
	}

	async moveHyperframesLayer(input: {
		projectId: string;
		sceneId: string;
		elementId: string;
		source: import("@/hyperframes/types").HyperframesSource;
		manifest: import("@/hyperframes/types").HyperframesRuntimeManifest;
		layerKey: string;
		startSeconds: number;
		signal: AbortSignal;
	}): Promise<void> {
		return this.applyHyperframesSourceEdit({ ...input, kind: "layerMove" });
	}

	private async applyHyperframesSourceEdit(
		input: {
			projectId: string;
			sceneId: string;
			elementId: string;
			source: import("@/hyperframes/types").HyperframesSource;
			signal: AbortSignal;
		} & (
			| { kind: "variables"; values: Record<string, unknown> }
			| { kind: "files"; changes: Record<string, string | null> }
			| {
					kind: "layerMove";
					manifest: import("@/hyperframes/types").HyperframesRuntimeManifest;
					layerKey: string;
					startSeconds: number;
			  }
		),
	): Promise<void> {
		const { projectId, sceneId, elementId, source, signal } = input;
		const accountId = window.__opencutAccountId;
		const checkTarget = () => {
			signal.throwIfAborted();
			assertBatchEditable(projectId);
			if (
				window.__opencutAccountId !== accountId ||
				this.editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				this.editor.scenes.getActiveSceneOrNull()?.id !== sceneId
			)
				throw new Error("The target project, account or scene changed");
		};
		checkTarget();
		await this.enableCanonical();
		checkTarget();
		if (!this.canonical || this.canonical.projectId !== projectId)
			throw new Error("The canonical project was closed");
		const expectedRevision = this.canonical.status().revision;
		let moveScripts: Record<string, string> | undefined;
		let movedSource:
			| import("@/hyperframes/types").HyperframesSource
			| undefined;
		let moveFingerprint = "";
		let moveStrategy: import("@/hyperframes/types").HyperframesLayerMoveStrategy =
			"auto";
		if (input.kind === "layerMove") {
			const moveInput = {
				source,
				manifest: input.manifest,
				layerKey: input.layerKey,
				startSeconds: input.startSeconds,
			};
			let plan = this.canonical.planHyperframesLayerMove(moveInput);
			const { compileHyperframesLayerMove } =
				await import("@/hyperframes/layer-move-compiler");
			checkTarget();
			try {
				moveScripts = compileHyperframesLayerMove({ plan });
			} catch (error) {
				if (plan.strategy !== "source") throw error;
				// Rust revalidates eligibility. The runtime adapter handles helper
				// functions only after checking actual GSAP target ownership.
				plan = this.canonical.planHyperframesLayerMove({
					...moveInput,
					strategy: "runtime",
				});
				moveScripts = compileHyperframesLayerMove({ plan });
			}
			moveStrategy = plan.strategy;
			if (!this.canonical || this.canonical.projectId !== projectId)
				throw new Error("The canonical project was closed");
			movedSource = this.canonical.prepareHyperframesLayerMove({
				...moveInput,
				strategy: moveStrategy,
				scripts: moveScripts,
			});
			moveFingerprint = plan.sourceFingerprint;
		}
		const prepared =
			input.kind === "layerMove"
				? { source: movedSource!, sourceFingerprint: moveFingerprint }
				: input.kind === "variables"
					? {
							source: this.canonical.prepareHyperframesVariables({
								source,
								values: input.values,
							}),
							sourceFingerprint: "",
						}
					: this.canonical.prepareHyperframesSource({
							source,
							changes: input.changes,
						});
		const { HyperframesRenderClient } =
			await import("@/hyperframes/render-client");
		checkTarget();
		const client = new HyperframesRenderClient(projectId);
		const abort = () => client.dispose();
		signal.addEventListener("abort", abort, { once: true });
		try {
			const ready = await client.prepareSource(prepared.source);
			checkTarget();
			this.executeTransaction({
				execute: () => {
					if (!this.canonical || this.canonical.projectId !== projectId)
						throw new Error("The canonical project was closed");
					const target = {
						sceneId,
						elementId,
						manifest: ready.runtimeManifest,
						expectedRevision,
					};
					if (input.kind === "variables")
						this.canonical.setHyperframesVariables({
							...target,
							values: input.values,
						});
					else if (input.kind === "layerMove")
						this.canonical.moveHyperframesLayer({
							...target,
							layerKey: input.layerKey,
							startSeconds: input.startSeconds,
							strategy: moveStrategy,
							sourceFingerprint: prepared.sourceFingerprint,
							scripts: moveScripts!,
						});
					else
						this.canonical.setHyperframesSource({
							...target,
							changes: input.changes,
							sourceFingerprint: prepared.sourceFingerprint,
						});
					this.publishCanonical();
				},
			});
		} finally {
			signal.removeEventListener("abort", abort);
			client.dispose();
		}
	}

	async setHyperframesManifest(
		input: Parameters<CanonicalClassicSession["setHyperframesManifest"]>[0] & {
			projectId: string;
			signal?: AbortSignal;
		},
	): Promise<void> {
		const { projectId, signal, ...request } = input;
		const checkTarget = () => {
			signal?.throwIfAborted();
			assertBatchEditable(projectId);
			if (this.editor.project.getActiveOrNull()?.metadata.id !== projectId)
				throw new Error("The target project is no longer active");
		};
		checkTarget();
		await this.enableCanonical();
		checkTarget();
		this.executeTransaction({
			execute: () => {
				if (!this.canonical)
					throw new Error("The canonical project was closed");
				this.canonical.setHyperframesManifest(request);
				this.publishCanonical();
			},
		});
	}

	private releaseCanonical(): void {
		const currentUrls = new Set(
			this.editor.media
				?.getAssets()
				.flatMap((asset) => [asset.url, asset.thumbnailUrl]),
		);
		for (const asset of this.canonicalMediaHandles.values()) {
			for (const url of [asset.url, asset.thumbnailUrl]) {
				if (url?.startsWith("blob:") && !currentUrls.has(url))
					URL.revokeObjectURL(url);
			}
		}
		this.canonicalMediaHandles.clear();
		this.clipUpdateGesture = undefined;
		this.settingsGesture = undefined;
		this.effectGesture = undefined;
		this.unsubscribeEffectCatalog?.();
		this.unsubscribeEffectCatalog = null;
		this.unsubscribeMaskCatalog?.();
		this.unsubscribeMaskCatalog = null;
		this.unsubscribeAnimationCatalog?.();
		this.unsubscribeAnimationCatalog = null;
		this.maskPreview = null;
		this.canonical?.dispose();
		this.canonical = null;
		this.canonicalArchive = null;
		this.sessionPersistence = null;
		// The caller drains writable history before detaching. A disposed read-only
		// viewer may still receive an old agent cleanup rejection; that belongs to
		// its caller, never to the next canonical session's flush queue.
		this.historySaveQueue = Promise.resolve();
		this.scheduledSessionSave = null;
		this.canonicalCallbacks.clear();
	}

	private captureMediaBindings() {
		return canonicalMediaBindings(this.editor.media?.getAssets() ?? []);
	}

	planEditingProviderRetry(
		failure: import("@/editor-agent/transport").ProviderFailureInput,
	): import("@/editor-agent/transport").ProviderRetryPlan {
		if (!this.canonical)
			throw new Error(
				"Provider recovery requires the active canonical session",
			);
		return this.canonical.providerRetryPlan(failure);
	}

	private canonicalView(): CanonicalClassicSnapshot {
		const project = this.editor.project.getActiveOrNull();
		if (!project) throw new Error("No active Classic project");
		return {
			document: this.snapshotOfProject({
				project,
				scenes: this.editor.scenes.getScenes(),
			}),
			mediaAssets: this.captureMediaBindings(),
		};
	}

	private synchronizeCanonicalViews(): void {
		if (this.canonical && this.silenceCommit) {
			this.canonical.commitSilence({
				...this.silenceCommit,
				idempotencyKey: generateUUID(),
				classic: this.canonicalView(),
			});
			return;
		}
		this.canonical?.synchronize({ classic: this.canonicalView() });
	}

	private publishCanonical(): void {
		if (!this.canonical) return;
		const projectId = this.canonical.projectId;
		const state = this.canonical.read();
		this.isProjectingCanonical = true;
		try {
			this.restoreProjectSnapshot({ snapshot: state.document });
			for (const asset of this.editor.media.getAssets())
				this.canonicalMediaHandles.set(asset.id, asset);
			const handles = this.canonicalMediaHandles;
			this.editor.media.setAssets({
				assets: state.mediaAssets.map((asset) => ({
					...asset,
					file: handles.get(asset.id)?.file,
					url:
						handles.get(asset.id)?.url ??
						(!asset.missing && asset.storageKind
							? localMediaUrl({ projectId, id: asset.id })
							: undefined),
					thumbnailUrl: handles.get(asset.id)?.thumbnailUrl,
				})),
			});
		} finally {
			this.isProjectingCanonical = false;
		}
	}

	private moveCanonicalHistory(direction: "undo" | "redo"): void {
		const session = this.canonical;
		if (!session) return;
		const status = session.status();
		if (!(direction === "undo" ? status.canUndo : status.canRedo)) return;
		const context =
			(direction === "undo" ? status.undoContext : status.redoContext) ?? {};
		const callback =
			typeof context.callbackId === "string"
				? this.canonicalCallbacks.get(context.callbackId)
				: undefined;
		const previousSelection = this.getSelectionSnapshot();
		let selectionOverride: EditorSelectionSnapshot | undefined;
		let draft: CanonicalClassicSnapshot | undefined;
		this.isProjectingCanonical = true;
		this.transactionDepth += 1;
		try {
			if (callback) {
				if (direction === "undo") callback.undo();
				else {
					const beforeTracks = this.isRippleEnabled
						? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
						: null;
					selectionOverride = this.applySelectionOverride(callback.redo());
					if (!callback.effectsOnly) {
						if (callback.applyRipple !== false)
							this.applyRippleIfEnabled({ beforeTracks });
						if (callback.runReactors !== false) this.runReactors();
					}
				}
				if (!callback.effectsOnly) draft = this.canonicalView();
			}
			if (draft) session.synchronize({ classic: draft, dryRun: true });
		} catch (error) {
			this.publishCanonical();
			this.editor.selection.restoreSnapshot({ snapshot: previousSelection });
			throw error;
		} finally {
			this.isProjectingCanonical = false;
			this.transactionDepth -= 1;
		}
		const action =
			direction === "undo"
				? session.undo()
				: session.redo({
						previousSelection,
						...(callback &&
							!callback.effectsOnly && {
								selectionOverride: selectionOverride ?? null,
							}),
					});
		// Classic UI transactions retain imported library resources for redo.
		// Native capabilities own media membership as part of their history;
		// publishCanonical reattaches binary handles only to restored IDs.
		if (draft) session.synchronize({ classic: draft });
		else if (
			context.retainMediaResources === true ||
			(context.retainMediaResources === undefined &&
				typeof context.persistable === "boolean")
		)
			session.synchronize({
				classic: {
					...session.read(),
					mediaAssets: this.captureMediaBindings(),
				},
			});
		this.publishCanonical();
		const restoreSelection =
			direction === "undo"
				? action.hostContext.previousSelection
				: action.hostContext.selectionOverride;
		if (
			action.hostContext.selectionOverride &&
			this.isSelectionSnapshot(restoreSelection)
		)
			this.editor.selection.restoreSnapshot({ snapshot: restoreSelection });
		this.stateRevision += 1;
		this.persistHistory();
	}

	private isSelectionSnapshot(
		value: unknown,
	): value is EditorSelectionSnapshot {
		if (!value || typeof value !== "object") return false;
		return (
			"selectedElements" in value &&
			Array.isArray(value.selectedElements) &&
			"selectedTextWords" in value &&
			Array.isArray(value.selectedTextWords) &&
			"selectedKeyframes" in value &&
			Array.isArray(value.selectedKeyframes) &&
			"keyframeSelectionAnchor" in value &&
			"selectedMaskPoints" in value
		);
	}

	captureProjectSnapshot(): SerializedProjectHistorySnapshot | null {
		const project = this.editor.project.getActiveOrNull();
		if (!project) {
			return null;
		}

		return this.cloneData(
			this.snapshotOfProject({
				project,
				scenes: this.editor.scenes.getScenes(),
			}),
		);
	}

	private snapshotOfProject({
		project,
		scenes,
	}: {
		project: TProject;
		scenes: TProject["scenes"];
	}): SerializedProjectHistorySnapshot {
		const duration =
			project.metadata.duration ?? getProjectDurationFromScenes({ scenes });
		this.activeProjectId = project.metadata.id;
		const { thumbnail: _thumbnail, ...metadata } = project.metadata;

		return {
			...project,
			metadata: {
				...metadata,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: scenes.map((scene) => ({
				...scene,
				tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
				createdAt: scene.createdAt.toISOString(),
				updatedAt: scene.updatedAt.toISOString(),
			})),
			aiEditHistory: project.aiEditHistory ?? [],
		};
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private notifyHistoryChange(): void {
		for (const listener of this.historyListeners) listener();
	}

	private persistHistory(): void {
		// Views may be published before the canonical history transaction commits.
		// Notify here so controls read the final Undo/Redo availability.
		this.notifyHistoryChange();
		if (this.sessionPersistence) {
			void this.persistEditingSession().catch((error) => {
				console.error("Failed to persist the editor session:", error);
			});
			return;
		}
		const projectId =
			this.editor.project.getActiveOrNull()?.metadata.id ??
			this.activeProjectId;
		if (!projectId) {
			return;
		}

		const history = this.serializeHistory({ projectId });
		this.historySaveQueue = this.historySaveQueue
			.catch(() => undefined)
			.then(() => storageService.saveCommandHistory({ history }))
			.catch((error) => {
				console.error("Failed to save command history:", error);
			});
	}

	private serializeHistory({ projectId }: { projectId: string }) {
		if (this.canonical)
			return {
				projectId,
				schemaVersion: 2,
				undoStack: [],
				redoStack: [],
				canonicalArchive: this.canonical.archive(),
				updatedAt: new Date().toISOString(),
			};
		return {
			projectId,
			schemaVersion: COMMAND_HISTORY_SCHEMA_VERSION,
			undoStack: this.serializeEntries(this.history),
			redoStack: this.serializeEntries(this.redoStack),
			updatedAt: new Date().toISOString(),
		};
	}

	private serializeEntries(
		entries: CommandHistoryEntry[],
	): SerializedCommandHistoryEntry[] {
		const lastBoundaryIndex = entries.findLastIndex(
			(entry) => !this.canSerializeEntry(entry),
		);
		return entries
			.slice(lastBoundaryIndex + 1)
			.flatMap((entry) => {
				if (!entry.beforeSnapshot || !entry.afterSnapshot) {
					return [];
				}
				return [
					{
						before: this.cloneData(entry.beforeSnapshot),
						after: this.cloneData(entry.afterSnapshot),
						previousSelection: this.cloneData(entry.previousSelection),
						...(entry.selectionOverride !== undefined && {
							selectionOverride: this.cloneData(entry.selectionOverride),
						}),
					},
				];
			})
			.slice(-MAX_PERSISTED_HISTORY_ENTRIES);
	}

	private canSerializeEntry(entry: CommandHistoryEntry): boolean {
		return Boolean(
			entry.beforeSnapshot &&
			entry.afterSnapshot &&
			(entry.command?.canPersistHistory ?? true),
		);
	}

	private fromSerializedEntry(
		entry: SerializedCommandHistoryEntry,
	): CommandHistoryEntry {
		return {
			beforeSnapshot: entry.before,
			afterSnapshot: entry.after,
			previousSelection: entry.previousSelection,
			selectionOverride: entry.selectionOverride,
		};
	}

	private restoreProjectSnapshot({
		snapshot,
	}: {
		snapshot: SerializedProjectHistorySnapshot;
	}): void {
		const currentProject = this.editor.project.getActiveOrNull();
		const copy = this.cloneData(snapshot);
		const project: TProject = {
			...copy,
			metadata: {
				...copy.metadata,
				thumbnail:
					currentProject?.metadata.id === snapshot.metadata.id
						? currentProject.metadata.thumbnail
						: undefined,
				createdAt: new Date(snapshot.metadata.createdAt),
				updatedAt: new Date(snapshot.metadata.updatedAt),
			},
			scenes: copy.scenes.map((scene) => ({
				...scene,
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})),
			aiEditHistory: copy.aiEditHistory ?? [],
		};

		this.editor.save.pause();
		try {
			this.editor.project.setActiveProject({ project });
			this.editor.scenes.initializeScenes({
				scenes: project.scenes,
				currentSceneId: project.currentSceneId,
			});
		} finally {
			this.editor.save.resume();
		}
		this.editor.save.markDirty({ force: true });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map(
					({ buffer: _buffer, ...element }) => element,
				),
			})),
		};
	}

	private cloneData<T>(value: T): T {
		return structuredClone(value);
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		if (this.canonical && !this.isProjectingCanonical) {
			this.synchronizeCanonicalViews();
			const sceneId = this.editor.scenes.getActiveScene().id;
			const changed = this.canonical.applyRipple({
				sceneId,
				beforeTracks: [
					...beforeTracks.overlay,
					beforeTracks.main,
					...beforeTracks.audio,
				].map((track) => ({
					id: track.id,
					elements: track.elements.map(({ id, startTime, duration }) => ({
						id,
						startTime,
						duration,
					})),
				})),
			});
			if (changed) this.publishCanonical();
			return;
		}
		// Retained only for preflight replay of legacy host-effect callbacks.
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
