/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Rust validates the live registry contracts before returning these JSON projections. */
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { MediaAsset } from "@/media/types";
import type { SerializedProjectHistorySnapshot } from "@/services/storage/types";
import type {
	HyperframesSource,
	HyperframesRuntimeManifest,
} from "@/hyperframes/types";

export interface CanonicalClassicSnapshot {
	document: SerializedProjectHistorySnapshot;
	mediaAssets: Array<Omit<MediaAsset, "file" | "url" | "thumbnailUrl">>;
}

export interface CanonicalHistoryBoundary {
	label: string;
	classic: CanonicalClassicSnapshot;
	hostContext: Record<string, unknown>;
}

/** Opaque persisted protocol; only Rust resolves source references in this archive. */
export interface CanonicalHistoryArchive {
	schemaVersion: number;
	projectId: string;
	revision: number;
	classic: unknown;
	undoStack: unknown[];
	redoStack: unknown[];
	sources: Record<string, HyperframesSource>;
}

interface SessionStatus {
	projectId: string;
	revision: number;
	canUndo: boolean;
	canRedo: boolean;
	undoContext: Record<string, unknown> | null;
	redoContext: Record<string, unknown> | null;
}

export interface CanonicalHistoryAction {
	revision: number;
	canUndo: boolean;
	canRedo: boolean;
	hostContext: Record<string, unknown>;
}

/** Browser adapter only. Documents, validation, history and source ownership stay in Rust. */
export class CanonicalClassicSession {
	private readonly runtime: CanonicalEditorRuntime;
	readonly projectId: string;
	constructor({
		runtime,
		projectId,
	}: {
		runtime: CanonicalEditorRuntime;
		projectId: string;
	}) {
		this.runtime = runtime;
		this.projectId = projectId;
	}

	attach({
		classic,
		undoStack = [],
		redoStack = [],
	}: {
		classic: CanonicalClassicSnapshot;
		undoStack?: CanonicalHistoryBoundary[];
		redoStack?: CanonicalHistoryBoundary[];
	}): void {
		this.call({
			capability: "project.classic.session.attach",
			input: {
				projectId: this.projectId,
				expectedRevision: 0,
				classic,
				undoStack,
				redoStack,
			},
		});
	}

	restore(archive: CanonicalHistoryArchive): void {
		this.call({
			capability: "project.classic.session.restore",
			input: {
				projectId: this.projectId,
				expectedRevision: 0,
				archive,
			},
		});
	}

	read(): CanonicalClassicSnapshot {
		const state = this.runtime.snapshot() as {
			project: { id: string; classic: CanonicalClassicSnapshot };
		};
		if (state.project.id !== this.projectId) {
			throw new Error("The canonical Classic project changed");
		}
		return state.project.classic;
	}

	status(): SessionStatus {
		return this.call({
			capability: "project.classic.session.status",
			input: {
				projectId: this.projectId,
			},
		});
	}

	synchronize({
		classic,
		dryRun = false,
	}: {
		classic: CanonicalClassicSnapshot;
		dryRun?: boolean;
	}): void {
		this.call({
			capability: "project.classic.synchronize",
			input: {
				projectId: this.projectId,
				expectedRevision: this.status().revision,
				classic,
			},
			context: { dryRun },
		});
	}

	begin(): void {
		this.runtime.beginTransaction(this.projectId, this.status().revision);
	}

	commit({
		label,
		hostContext,
	}: {
		label: string;
		hostContext: Record<string, unknown>;
	}): void {
		this.runtime.commitTransaction(label, hostContext);
	}

	rollback(): void {
		this.runtime.rollbackTransaction();
	}

	undo(): CanonicalHistoryAction {
		return this.moveHistory({ capability: "history.undo" });
	}
	redo(hostContext?: Record<string, unknown>): CanonicalHistoryAction {
		return this.moveHistory({ capability: "history.redo", hostContext });
	}

	archive(): CanonicalHistoryArchive {
		return this.call({
			capability: "project.classic.session.archive",
			input: {
				projectId: this.projectId,
				persistableOnly: true,
			},
		});
	}

	importHyperframes(input: {
		name: string;
		source: HyperframesSource;
		startSeconds?: number;
		trackId?: string;
		resolvedDurationSeconds?: number;
		runtimeManifest?: HyperframesRuntimeManifest;
		classicResourceAssets?: CanonicalClassicSnapshot["mediaAssets"];
	}): { assetId: string; itemId: string; trackId: string } {
		return this.call({
			capability: "timeline.hyperframes.import",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	previewHyperframesImport(
		input: Parameters<CanonicalClassicSession["importHyperframes"]>[0],
	): { assetId: string; itemId: string; trackId: string } {
		return this.call({
			capability: "timeline.hyperframes.import",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
			context: { dryRun: true },
		});
	}

	setHyperframesManifest(input: {
		assetId: string;
		manifest: HyperframesRuntimeManifest;
	}): void {
		this.call({
			capability: "hyperframes.manifest.set",
			input: {
				...input,
				projectId: this.projectId,
				expectedRevision: this.status().revision,
			},
		});
	}

	dispose(): void {
		this.runtime.free();
	}

	clearHistory(): void {
		// Portable runtime restoration retains the document and resets history.
		this.runtime.restore(this.runtime.serialize());
	}

	private moveHistory({
		capability,
		hostContext,
	}: {
		capability: "history.undo" | "history.redo";
		hostContext?: Record<string, unknown>;
	}): CanonicalHistoryAction {
		return this.call({
			capability,
			input: {},
			context: {
				metadata: {
					"opencut/projectId": this.projectId,
					"opencut/expectedRevision": this.status().revision,
					...(hostContext && { "opencut/historyContext": hostContext }),
				},
			},
		});
	}

	private call<T>({
		capability,
		input,
		context,
	}: {
		capability: string;
		input: unknown;
		context?: unknown;
	}): T {
		const receipt = this.runtime.invokeSync(capability, input, context) as {
			result: { data: T };
		};
		return receipt.result.data;
	}
}

/** Browser handles remain in MediaManager; only durable metadata crosses WASM. */
export function canonicalMediaBindings(
	assets: MediaAsset[],
): CanonicalClassicSnapshot["mediaAssets"] {
	return assets.map(
		({ file, url: _url, thumbnailUrl: _thumbnailUrl, ...asset }) => ({
			...asset,
			size: asset.size ?? file?.size ?? 0,
			lastModified: asset.lastModified ?? file?.lastModified ?? 0,
		}),
	);
}
