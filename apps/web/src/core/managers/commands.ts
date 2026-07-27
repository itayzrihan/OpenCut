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

const COMMAND_HISTORY_SCHEMA_VERSION = 1;
const MAX_PERSISTED_HISTORY_ENTRIES = 100;

interface CommandHistoryEntry {
	command?: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
	beforeSnapshot?: SerializedProjectHistorySnapshot;
	afterSnapshot?: SerializedProjectHistorySnapshot;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	private activeProjectId: string | null = null;
	private historySaveQueue: Promise<void> = Promise.resolve();
	private transactionDepth = 0;

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const shouldRecordHistory = this.transactionDepth === 0;
		const beforeSnapshot =
			shouldRecordHistory && command.canPersistHistory
				? this.captureProjectSnapshot()
				: null;
		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		if (!shouldRecordHistory) {
			return command;
		}
		const afterSnapshot = command.canPersistHistory
			? this.captureProjectSnapshot()
			: null;
		this.history.push({
			command,
			previousSelection,
			selectionOverride,
			beforeSnapshot: beforeSnapshot ?? undefined,
			afterSnapshot: afterSnapshot ?? undefined,
		});
		this.redoStack = [];
		this.persistHistory();
		return command;
	}

	/** Execute several editor commands as one atomic, persisted undo entry. */
	executeTransaction<T>({ execute }: { execute: () => T }): T {
		if (this.transactionDepth > 0) {
			return execute();
		}

		const beforeSnapshot = this.captureProjectSnapshot();
		const previousSelection = this.getSelectionSnapshot();
		this.transactionDepth += 1;
		try {
			const result = execute();
			const afterSnapshot = this.captureProjectSnapshot();
			if (beforeSnapshot && afterSnapshot) {
				this.history.push({
					previousSelection,
					selectionOverride: this.getSelectionSnapshot(),
					beforeSnapshot,
					afterSnapshot,
				});
				this.redoStack = [];
				this.persistHistory();
			}
			return result;
		} catch (error) {
			if (beforeSnapshot) {
				this.restoreProjectSnapshot({ snapshot: beforeSnapshot });
			}
			this.editor.selection.restoreSnapshot({ snapshot: previousSelection });
			throw error;
		} finally {
			this.transactionDepth -= 1;
		}
	}

	push({
		command,
		beforeSnapshot,
	}: {
		command: Command;
		beforeSnapshot?: SerializedProjectHistorySnapshot | null;
	}): void {
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
		this.persistHistory();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	async loadHistory({ projectId }: { projectId: string }): Promise<void> {
		this.activeProjectId = projectId;

		try {
			const persisted = await storageService.loadCommandHistory({ projectId });
			if (this.activeProjectId !== projectId) {
				return;
			}
			if (
				!persisted ||
				persisted.projectId !== projectId ||
				persisted.schemaVersion !== COMMAND_HISTORY_SCHEMA_VERSION
			) {
				this.history = [];
				this.redoStack = [];
				return;
			}

			this.history = persisted.undoStack.map((entry) =>
				this.fromSerializedEntry(entry),
			);
			this.redoStack = persisted.redoStack.map((entry) =>
				this.fromSerializedEntry(entry),
			);
		} catch (error) {
			console.error("Failed to load command history:", error);
			this.history = [];
			this.redoStack = [];
		}
	}

	async initializeEmptyHistory({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		this.activeProjectId = projectId;
		this.history = [];
		this.redoStack = [];
		try {
			await storageService.saveCommandHistory({
				history: this.serializeHistory({ projectId }),
			});
		} catch (error) {
			console.error("Failed to initialize command history:", error);
		}
	}

	undo(): void {
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
		this.persistHistory();
	}

	redo(): void {
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
			afterSnapshot = entry.command.canPersistHistory
				? (this.captureProjectSnapshot() ?? afterSnapshot)
				: undefined;
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
		});
		this.persistHistory();
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear({ persist = true }: { persist?: boolean } = {}): void {
		this.history = [];
		this.redoStack = [];
		if (persist) {
			this.persistHistory();
		}
	}

	clearLoadedProject(): void {
		this.activeProjectId = null;
		this.clear({ persist: false });
	}

	async flushHistory(): Promise<void> {
		await this.historySaveQueue;
	}

	captureProjectSnapshot(): SerializedProjectHistorySnapshot | null {
		const project = this.editor.project.getActiveOrNull();
		if (!project) {
			return null;
		}

		const scenes = this.editor.scenes.getScenes();
		const duration =
			project.metadata.duration ?? getProjectDurationFromScenes({ scenes });
		this.activeProjectId = project.metadata.id;

		return {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: scenes.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
				bookmarks: this.cloneData(scene.bookmarks),
				createdAt: scene.createdAt.toISOString(),
				updatedAt: scene.updatedAt.toISOString(),
			})),
			currentSceneId: project.currentSceneId,
			settings: this.cloneData(project.settings),
			customFonts: project.customFonts
				? this.cloneData(project.customFonts)
				: undefined,
			aiEditHistory: project.aiEditHistory
				? this.cloneData(project.aiEditHistory)
				: [],
			version: project.version,
			timelineViewState: project.timelineViewState
				? this.cloneData(project.timelineViewState)
				: undefined,
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
		return Boolean(entry.beforeSnapshot && entry.afterSnapshot);
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
		const project: TProject = {
			metadata: {
				id: snapshot.metadata.id,
				name: snapshot.metadata.name,
				duration: snapshot.metadata.duration,
				thumbnail:
					currentProject?.metadata.id === snapshot.metadata.id
						? currentProject.metadata.thumbnail
						: undefined,
				createdAt: new Date(snapshot.metadata.createdAt),
				updatedAt: new Date(snapshot.metadata.updatedAt),
			},
			scenes: snapshot.scenes.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: this.cloneData(scene.tracks),
				bookmarks: this.cloneData(scene.bookmarks),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})),
			currentSceneId: snapshot.currentSceneId,
			settings: this.cloneData(snapshot.settings),
			customFonts: snapshot.customFonts
				? this.cloneData(snapshot.customFonts)
				: undefined,
			aiEditHistory: snapshot.aiEditHistory
				? this.cloneData(snapshot.aiEditHistory)
				: [],
			version: snapshot.version,
			timelineViewState: snapshot.timelineViewState
				? this.cloneData(snapshot.timelineViewState)
				: undefined,
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
		return this.cloneData({
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map(
					({ buffer: _buffer, ...element }) => element,
				),
			})),
		});
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
