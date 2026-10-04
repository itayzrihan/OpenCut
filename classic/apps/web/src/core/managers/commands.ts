import { assertBatchEditable } from "@/batch/read-only";
import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import { storageService } from "@/services/storage/service";
import type {
	SerializedCommandHistoryEntry,
	SerializedProjectHistorySnapshot,
} from "@/services/storage/types";
import type { TProject } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { SceneTracks } from "@/timeline/types";
import type { MediaAsset } from "@/media/types";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import { generateUUID } from "@/utils/id";
import { localMediaUrl } from "@/services/local-drive/client";
import {
	CanonicalClassicSession,
	canonicalMediaBindings,
	type CanonicalClassicSnapshot,
	type CanonicalHistoryArchive,
	type CanonicalHistoryBoundary,
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
	private reactors: Array<() => void> = [];
	private activeProjectId: string | null = null;
	private historySaveQueue: Promise<void> = Promise.resolve();
	private transactionDepth = 0;
	private stateRevision = 0;
	private canonical: CanonicalClassicSession | null = null;
	private canonicalArchive: CanonicalHistoryArchive | null = null;
	private canonicalCallbacks = new Map<string, CanonicalCallback>();
	private canonicalFrameCommands: Command[] = [];
	private isProjectingCanonical = false;

	constructor(private editor: EditorCore) {}

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

	/** Execute several editor commands as one atomic, persisted undo entry. */
	executeTransaction<T>({ execute }: { execute: () => T }): T {
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

	async loadHistory({ projectId }: { projectId: string }): Promise<void> {
		this.releaseCanonical();
		this.activeProjectId = projectId;

		try {
			const persisted = await storageService.loadCommandHistory({ projectId });
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
		}
	}

	clearLoadedProject(): void {
		this.releaseCanonical();
		this.activeProjectId = null;
		this.clear({ persist: false });
	}

	async flushHistory(): Promise<void> {
		await this.historySaveQueue;
	}

	hasCanonicalHistory(): boolean {
		return this.canonical !== null || this.canonicalArchive !== null;
	}
	detachCanonical(): void {
		this.releaseCanonical();
	}

	async enableCanonical({
		runtime,
	}: { runtime?: CanonicalEditorRuntime } = {}): Promise<void> {
		if (this.canonical) return;
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		if (!projectId)
			throw new Error("Open a project before attaching its runtime");
		const binding = runtime ?? (await loadCanonicalRuntime());
		if (this.canonical) {
			binding.free();
			return;
		}
		if (this.editor.project.getActiveOrNull()?.metadata.id !== projectId) {
			binding.free();
			throw new Error("The active project changed while loading its runtime");
		}
		const session = new CanonicalClassicSession({
			runtime: binding,
			projectId,
		});
		try {
			const classic = this.canonicalView();
			if (this.canonicalArchive) {
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
			this.canonicalArchive = null;
			this.history = [];
			this.redoStack = [];
			this.stateRevision += 1;
		} catch (error) {
			session.dispose();
			this.canonicalCallbacks.clear();
			throw error;
		}
		this.persistHistory();
	}

	/** ProjectManager publishes this view only after canonical validation succeeds. */
	synchronizeProject(project: TProject | null): void {
		if (!this.canonical || this.isProjectingCanonical) return;
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
		this.canonical.synchronize({
			classic: {
				...this.canonical.read(),
				mediaAssets: canonicalMediaBindings(assets),
			},
			dryRun,
		});
		if (!dryRun) this.stateRevision += 1;
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
		this.canonical?.dispose();
		this.canonical = null;
		this.canonicalArchive = null;
		this.canonicalCallbacks.clear();
	}

	private captureMediaBindings() {
		return canonicalMediaBindings(this.editor.media?.getAssets() ?? []);
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
		this.canonical?.synchronize({ classic: this.canonicalView() });
	}

	private publishCanonical(): void {
		if (!this.canonical) return;
		const projectId = this.canonical.projectId;
		const state = this.canonical.read();
		this.isProjectingCanonical = true;
		try {
			this.restoreProjectSnapshot({ snapshot: state.document });
			const handles = new Map(
				this.editor.media.getAssets().map((asset) => [asset.id, asset]),
			);
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
		// Live commands keep their existing selective undo behavior. Persisted
		// boundaries restore the document and leave live media handles in the host.
		if (draft) session.synchronize({ classic: draft });
		else
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

	private persistHistory(): void {
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
