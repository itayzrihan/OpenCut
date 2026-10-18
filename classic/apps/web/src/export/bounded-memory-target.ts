import { StreamTarget, type StreamTargetChunk } from "mediabunny";

/** Short fixture compatibility only. Product exports use DiskExportTarget. */
export class BoundedMemoryTarget {
	private bytes = new Uint8Array(1024 * 1024);
	private length = 0;
	readonly target = new StreamTarget(
		new WritableStream<StreamTargetChunk>({
			write: ({ data, position }) => {
				const end = position + data.byteLength;
				if (end > 64 * 1024 * 1024)
					throw new Error("In-memory export exceeds 64 MiB; use a disk target");
				if (end > this.bytes.length) {
					const grown = new Uint8Array(
						Math.min(64 * 1024 * 1024, Math.max(end, this.bytes.length * 2)),
					);
					grown.set(this.bytes);
					this.bytes = grown;
				}
				this.bytes.set(data, position);
				this.length = Math.max(this.length, end);
			},
		}),
	);
	finish(): ArrayBuffer {
		return this.bytes.slice(0, this.length).buffer;
	}
}
