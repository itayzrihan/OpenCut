/** Optional Chromium APIs, used only for files the user explicitly selects. */
export interface BrowserFileHandle extends FileSystemFileHandle {
	requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
}

declare global {
	interface DataTransferItem {
		getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
	}
}
