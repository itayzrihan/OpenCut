/* eslint-disable opencut/prefer-object-params -- Internal filesystem adapters mirror platform handle, buffer and offset APIs. */
import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/** Commit the file only after successful muxer finalization. Mediabunny also
 * closes its stream on cancellation, so stream.close must NOT commit the file. */
export class DiskExportTarget {
	readonly target: StreamTarget;
	private settled = false;
	private constructor(
		private writer: FileSystemWritableFileStream,
		signal: AbortSignal,
		maxBytes = Infinity,
	) {
		this.target = new StreamTarget(
			new WritableStream<StreamTargetChunk>({
				write: async (chunk) => {
					signal.throwIfAborted();
					if (chunk.position + chunk.data.byteLength > maxBytes)
						throw new Error("Export exceeds the agent artifact limit");
					await writer.write(chunk);
				},
			}),
			{ chunked: true, chunkSize: 1024 * 1024 },
		);
	}
	static async open(
		handle: FileSystemFileHandle,
		signal: AbortSignal,
		maxBytes?: number,
	) {
		signal.throwIfAborted();
		return new DiskExportTarget(
			await handle.createWritable(),
			signal,
			maxBytes,
		);
	}
	async commit(): Promise<void> {
		await this.writer.close();
		this.settled = true;
	}
	async abort(): Promise<void> {
		if (!this.settled) await this.writer.abort().catch(() => undefined);
		this.settled = true;
	}
}
