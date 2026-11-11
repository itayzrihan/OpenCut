import type { BrowserFileHandle } from "./browser-file-handle";

export type DroppedFileHandles = ReadonlyMap<
	File,
	Promise<BrowserFileHandle | undefined>
>;

function isFileHandle(
	handle: FileSystemHandle | null,
): handle is BrowserFileHandle {
	return (
		handle?.kind === "file" &&
		"getFile" in handle &&
		typeof handle.getFile === "function"
	);
}

/** Chromium only exposes dropped handles during the drop event. Keep the File
 * as an immediate source and resolve the optional durable handle separately. */
export function captureFileDrop(transfer: DataTransfer) {
	const files = Array.from(transfer.files);
	const handles = new Map<File, Promise<BrowserFileHandle | undefined>>();
	const items = Array.from(transfer.items ?? []).filter(
		(item) => item.kind === "file",
	);
	if (items.length === files.length) {
		items.forEach((item, index) => {
			try {
				const result = item.getAsFileSystemHandle?.();
				if (result)
					handles.set(
						files[index],
						result
							.then((handle) => (isFileHandle(handle) ? handle : undefined))
							.catch(() => undefined),
					);
			} catch {
				// File input remains usable when this browser refuses a handle.
			}
		});
	}
	return { files, handles };
}
