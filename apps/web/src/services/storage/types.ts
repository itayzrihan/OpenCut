import type { MediaType } from "@/media/types";
import type { ProjectFont } from "@/fonts/types";
import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/project/types";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import type { TScene } from "@/timeline";

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	fileName?: string;
	mimeType?: string;
	storageKind?: "copied" | "linked";
	sourcePath?: string;
	missing?: boolean;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
}

export type ProjectFontData = ProjectFont;

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export type SerializedProjectHistorySnapshot = Omit<
	SerializedProject,
	"metadata"
> & {
	metadata: Omit<SerializedProjectMetadata, "thumbnail">;
};

export interface SerializedCommandHistoryEntry {
	before: SerializedProjectHistorySnapshot;
	after: SerializedProjectHistorySnapshot;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

export interface SerializedCommandHistory {
	projectId: string;
	schemaVersion: number;
	undoStack: SerializedCommandHistoryEntry[];
	redoStack: SerializedCommandHistoryEntry[];
	updatedAt: string;
}

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	fontsDb: string;
	commandHistoryDb: string;
	savedSoundsDb: string;
	version: number;
}

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
