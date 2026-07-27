import { open, type FileHandle } from "node:fs/promises";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Streams a bounded file range without Node's Readable.toWeb bridge.
 *
 * Media elements routinely cancel speculative range requests. The Node bridge
 * can race that cancellation and close an already-closed web controller,
 * turning a normal browser abort into an uncaught ERR_INVALID_STATE. This
 * stream owns the file handle and checks cancellation after every await before
 * touching the controller.
 */
export function createCancellationSafeFileStream({
	path,
	start,
	end,
	chunkBytes = DEFAULT_CHUNK_BYTES,
}: {
	path: string;
	start: number;
	end: number;
	chunkBytes?: number;
}): ReadableStream<Uint8Array> {
	let position = start;
	let cancelled = false;
	let fileHandlePromise: Promise<FileHandle> | null = null;
	let closePromise: Promise<void> | null = null;

	const getFileHandle = () => {
		fileHandlePromise ??= open(path, "r");
		return fileHandlePromise;
	};

	const closeFile = async () => {
		if (!fileHandlePromise) return;
		closePromise ??= fileHandlePromise
			.then((fileHandle) => fileHandle.close())
			.catch(() => undefined);
		await closePromise;
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (cancelled) return;

			const remainingBytes = end - position + 1;
			if (remainingBytes <= 0) {
				await closeFile();
				if (!cancelled) controller.close();
				return;
			}

			try {
				const fileHandle = await getFileHandle();
				if (cancelled) return;

				const buffer = new Uint8Array(
					Math.min(chunkBytes, remainingBytes),
				);
				const { bytesRead } = await fileHandle.read({
					buffer,
					offset: 0,
					length: buffer.byteLength,
					position,
				});
				if (cancelled) return;

				if (bytesRead === 0) {
					await closeFile();
					if (!cancelled) controller.close();
					return;
				}

				position += bytesRead;
				controller.enqueue(buffer.subarray(0, bytesRead));

				if (position > end) {
					await closeFile();
					if (!cancelled) controller.close();
				}
			} catch (error) {
				await closeFile();
				if (!cancelled) controller.error(error);
			}
		},
		async cancel() {
			cancelled = true;
			await closeFile();
		},
	});
}
