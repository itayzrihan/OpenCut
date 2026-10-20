/** Temporary host PCM, never editor/project state. A browser that cannot open
 * OPFS can still edit short scenes, within a strict per-job memory ceiling. */
import { ExportScratch } from "./scratch";
import type { PcmStorage, PcmWriter } from "./pcm-file";
export interface AudioScratch {
	readonly capacityBytes?: number;
	file(name: string): Promise<PcmStorage>;
	remove(name: string): Promise<void>;
	dispose(): Promise<void>;
}
const MAX_MEMORY_BYTES = 128 * 1024 ** 2;
type Entry = {
	bytes: Uint8Array;
	size: number;
	snapshot?: File;
	writing: boolean;
	deleted: boolean;
};
export class MemoryAudioScratch implements AudioScratch {
	private entries = new Map<string, Entry>();
	private used = 0;
	constructor(readonly capacityBytes = MAX_MEMORY_BYTES) {
		if (
			!Number.isSafeInteger(capacityBytes) ||
			capacityBytes < 1 ||
			capacityBytes > MAX_MEMORY_BYTES
		)
			throw Error("Invalid audio memory budget");
	}
	async file(name: string): Promise<PcmStorage> {
		let entry = this.entries.get(name);
		if (!entry) {
			entry = {
				bytes: new Uint8Array(0),
				size: 0,
				writing: false,
				deleted: false,
			};
			this.entries.set(name, entry);
		}
		const value = entry;
		const alive = () => {
			if (value.deleted)
				throw new DOMException("Audio scratch was disposed", "NotFoundError");
		};
		const resize = (size: number) => {
			alive();
			if (
				!Number.isSafeInteger(size) ||
				size < 0 ||
				this.used - value.size + size > this.capacityBytes
			)
				throw Error(
					"Audio exceeds the bounded memory fallback; restore browser temporary storage and resume the saved edit",
				);
			const next = new Uint8Array(size);
			next.set(value.bytes.subarray(0, size));
			this.used += size - value.size;
			value.size = size;
			value.bytes = next;
			value.snapshot = undefined;
		};
		return {
			createWritable: async (): Promise<PcmWriter> => {
				alive();
				if (value.writing) throw Error("Audio scratch already has a writer");
				resize(0);
				value.writing = true;
				const open = () => {
					alive();
					if (!value.writing) throw Error("Audio scratch writer is closed");
				};
				return {
					write: async ({ position, data }) => {
						open();
						if (!Number.isSafeInteger(position) || position < 0)
							throw Error("Invalid audio write");
						const end = position + data.byteLength;
						if (end > value.size) resize(end);
						value.bytes.set(data, position);
					},
					truncate: async (size) => {
						open();
						resize(size);
					},
					close: async () => {
						open();
						value.writing = false;
					},
					abort: async () => {
						if (value.deleted) return;
						resize(0);
						value.writing = false;
					},
				};
			},
			getFile: async () => {
				alive();
				if (value.writing) throw Error("Audio scratch is not sealed");
				if (!value.snapshot) {
					value.snapshot = new File([value.bytes.slice().buffer], name);
					value.bytes = new Uint8Array(0);
				}
				return value.snapshot;
			},
		};
	}
	async remove(name: string) {
		const value = this.entries.get(name);
		if (!value) return;
		this.used -= value.size;
		value.deleted = true;
		value.bytes = new Uint8Array(0);
		value.snapshot = undefined;
		this.entries.delete(name);
	}
	async dispose() {
		for (const name of [...this.entries.keys()]) await this.remove(name);
	}
}
export async function createAudioScratch(): Promise<AudioScratch> {
	try {
		return await ExportScratch.create();
	} catch (error) {
		console.warn(
			"Browser audio scratch unavailable; using bounded PCM memory",
			String(error),
		);
		return new MemoryAudioScratch();
	}
}
