import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
	retryDelaysMs?: readonly number[];
};

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class SaveManager {
	private debounceMs: number;
	private retryDelaysMs: readonly number[];
	private isPaused = false;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private savePromise: Promise<void> | null = null;
	private retryAttempt = 0;
	private nextRetryAt = 0;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
		retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
		this.retryDelaysMs = retryDelaysMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
		this.clearTimer();
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		if (!this.isPaused) {
			this.queueSave();
		}
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;
		this.clearTimer();

		// A change can arrive while a write is in flight. Keep flushing until the
		// latest observed editor state has completed its own durable write.
		while (this.hasPendingSave || this.savePromise) {
			await this.saveNow({ force: true });
		}
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.savePromise !== null;
	}

	/**
	 * Clear save bookkeeping after a project has been deliberately closed.
	 * This never cancels an in-flight write and must only be called after flush.
	 */
	discardPending(): void {
		this.hasPendingSave = false;
		this.retryAttempt = 0;
		this.nextRetryAt = 0;
		this.clearTimer();
	}

	private queueSave(): void {
		if (this.isPaused || this.savePromise || !this.hasPendingSave) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}

		const retryDelay = Math.max(0, this.nextRetryAt - Date.now());
		const delay = Math.max(this.debounceMs, retryDelay);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow().catch((error) => {
				console.error("Autosave failed; the project remains pending:", error);
			});
		}, delay);
	}

	private async saveNow({
		force = false,
	}: { force?: boolean } = {}): Promise<void> {
		if (this.savePromise) {
			await this.savePromise;
			return;
		}
		if (!this.hasPendingSave) return;
		if (this.isPaused && !force) return;

		const activeProject = this.editor.project.getActiveOrNull();
		if (!activeProject) {
			this.discardPending();
			return;
		}
		if (this.editor.project.getIsLoading()) {
			if (force) {
				throw new Error("Cannot save a project while it is loading");
			}
			return;
		}
		if (this.editor.project.getMigrationState().isMigrating) {
			if (force) {
				throw new Error("Cannot save a project while it is migrating");
			}
			return;
		}

		this.hasPendingSave = false;
		this.clearTimer();

		const savePromise = this.persistCurrentProject();
		this.savePromise = savePromise;
		try {
			await savePromise;
		} finally {
			if (this.savePromise === savePromise) {
				this.savePromise = null;
			}
			if (this.hasPendingSave && !this.isPaused) {
				this.queueSave();
			}
		}
	}

	private async persistCurrentProject(): Promise<void> {
		try {
			await this.editor.project.saveCurrentProject();
			this.retryAttempt = 0;
			this.nextRetryAt = 0;
		} catch (error) {
			// The state represented by the failed write is still unsaved. Restore the
			// dirty flag before surfacing the error and retry with capped backoff.
			this.hasPendingSave = true;
			const retryDelay = this.getRetryDelay();
			this.retryAttempt += 1;
			this.nextRetryAt = Date.now() + retryDelay;
			throw error;
		}
	}

	private getRetryDelay(): number {
		if (this.retryDelaysMs.length === 0) return this.debounceMs;
		const index = Math.min(this.retryAttempt, this.retryDelaysMs.length - 1);
		return Math.max(0, this.retryDelaysMs[index] ?? this.debounceMs);
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
