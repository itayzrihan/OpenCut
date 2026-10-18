/** Durable, bounded host analysis artifacts; editor/source authority stays in Rust. */
import type { AudioAnalysisFrame } from "opencut-wasm";
import { accountNamespace } from "@/accounts/browser";
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export interface AudioCheckpointStore {
	read(input: {
		key: string;
		duration: number;
	}): Promise<AudioAnalysisFrame[] | undefined>;
	write(input: {
		key: string;
		duration: number;
		frames: AudioAnalysisFrame[];
	}): Promise<void>;
}
export function packAudioFrames({
	frames,
	duration,
}: {
	frames: AudioAnalysisFrame[];
	duration: number;
}) {
	const data = new Float64Array(frames.length * 5);
	let previous = 0;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i];
		const row = [f.start, f.end, f.rms, f.peak, f.zeroCrossingRate ?? 0];
		if (
			!row.every(Number.isFinite) ||
			f.start < 0 ||
			f.end <= f.start ||
			f.end > duration + 1e-8 ||
			f.start < previous - 1e-8 ||
			f.rms < 0 ||
			f.peak < 0
		)
			throw new Error("Invalid audio checkpoint");
		data.set(row, i * 5);
		previous = f.end;
	}
	if (data.byteLength > MAX_RECORD_BYTES)
		throw new Error("Audio window checkpoint exceeds its bounded size");
	return data;
}
export function unpackAudioFrames({
	data,
	duration,
}: {
	data: unknown;
	duration: number;
}): AudioAnalysisFrame[] | undefined {
	if (
		!(data instanceof Float64Array) ||
		data.length % 5 ||
		data.byteLength > MAX_RECORD_BYTES
	)
		return undefined;
	const frames: AudioAnalysisFrame[] = [];
	for (let i = 0; i < data.length; i += 5)
		frames.push({
			start: data[i],
			end: data[i + 1],
			rms: data[i + 2],
			peak: data[i + 3],
			zeroCrossingRate: data[i + 4],
		});
	try {
		packAudioFrames({ frames, duration });
		return frames;
	} catch {
		return undefined;
	}
}
export class IndexedAudioCheckpoints implements AudioCheckpointStore {
	private factory: IDBFactory;
	private databaseName: string;
	private maxBytes: number;
	private maxEntries: number;
	private now: () => number;
	constructor({
		factory = globalThis.indexedDB,
		databaseName = accountNamespace("smart-audio-checkpoints-v1"),
		maxBytes = 64 * 1024 * 1024,
		maxEntries = 2048,
		now = Date.now,
	}: {
		factory?: IDBFactory;
		databaseName?: string;
		maxBytes?: number;
		maxEntries?: number;
		now?: () => number;
	} = {}) {
		this.factory = factory;
		this.databaseName = databaseName;
		this.maxBytes = maxBytes;
		this.maxEntries = maxEntries;
		this.now = now;
		if (
			!Number.isInteger(maxEntries) ||
			maxEntries < 1 ||
			!Number.isFinite(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > 64 * 1024 * 1024
		)
			throw new Error("Invalid audio cache budget");
	}
	private open(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = this.factory.open(this.databaseName, 1);
			request.onerror = () => reject(request.error);
			request.onupgradeneeded = () => {
				for (const name of ["windows", "sizes"])
					if (!request.result.objectStoreNames.contains(name))
						request.result.createObjectStore(name, { keyPath: "id" });
			};
			request.onsuccess = () => {
				request.result.onversionchange = () => request.result.close();
				resolve(request.result);
			};
		});
	}
	async read({ key, duration }: { key: string; duration: number }) {
		const db = await this.open();
		return new Promise<AudioAnalysisFrame[] | undefined>((resolve, reject) => {
			let frames: AudioAnalysisFrame[] | undefined;
			const tx = db.transaction(["windows", "sizes"], "readwrite");
			tx.oncomplete = () => {
				db.close();
				resolve(frames);
			};
			tx.onabort = tx.onerror = () => {
				db.close();
				reject(tx.error ?? new Error("Audio checkpoint read failed"));
			};
			const request = tx.objectStore("windows").get(key);
			request.onsuccess = () => {
				const value: unknown = request.result;
				if (
					value &&
					typeof value === "object" &&
					"version" in value &&
					value.version === 1 &&
					"duration" in value &&
					value.duration === duration &&
					"data" in value
				) {
					frames = unpackAudioFrames({ data: value.data, duration });
					if (frames && value.data instanceof Float64Array)
						tx.objectStore("sizes").put({
							id: key,
							bytes: value.data.byteLength,
							at: this.now(),
						});
				}
			};
		});
	}
	async write({
		key,
		duration,
		frames,
	}: {
		key: string;
		duration: number;
		frames: AudioAnalysisFrame[];
	}) {
		const data = packAudioFrames({ frames, duration });
		if (data.byteLength > this.maxBytes)
			throw new Error("Audio checkpoint cannot fit its cache budget");
		const db = await this.open();
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(["windows", "sizes"], "readwrite");
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onabort = tx.onerror = () => {
				db.close();
				reject(tx.error ?? new Error("Audio checkpoint save failed"));
			};
			const windows = tx.objectStore("windows"),
				sizes = tx.objectStore("sizes");
			const request = sizes.getAll();
			request.onsuccess = () => {
				const entries = (
					request.result as Array<{ id: string; bytes: number; at: number }>
				)
					.filter((e) => e.id !== key)
					.sort((a, b) => a.at - b.at);
				let total =
					entries.reduce((sum, e) => sum + e.bytes, 0) + data.byteLength;
				while (entries.length >= this.maxEntries || total > this.maxBytes) {
					const old = entries.shift();
					if (!old) break;
					windows.delete(old.id);
					sizes.delete(old.id);
					total -= old.bytes;
				}
				windows.put({ id: key, version: 1, duration, data });
				sizes.put({ id: key, bytes: data.byteLength, at: this.now() });
			};
		});
	}
}
export async function audioCheckpointKey({ value }: { value: unknown }) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}
