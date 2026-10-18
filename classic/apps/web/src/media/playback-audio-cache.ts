/** Disposable decoded media only. Retain a bounded recent working set rather
 * than every short ever played; scheduled Web Audio nodes keep their own data. */
export class PlaybackAudioCache {
	private entries = new Map<
		string,
		{ promise: Promise<AudioBuffer | null>; bytes: number }
	>();
	private bytes = 0;
	constructor(
		private maxBytes = 64 * 1024 ** 2,
		private maxEntries = 16,
	) {}
	get size() {
		return this.entries.size;
	}
	get(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.promise;
	}
	set(key: string, promise: Promise<AudioBuffer | null>) {
		this.delete(key);
		const entry = { promise, bytes: 0 };
		this.entries.set(key, entry);
		this.prune();
		void promise.then(
			(buffer) => {
				if (this.entries.get(key) !== entry) return;
				if (!buffer) {
					this.delete(key);
					return;
				}
				entry.bytes = buffer.length * buffer.numberOfChannels * 4;
				this.bytes += entry.bytes;
				if (entry.bytes > this.maxBytes) {
					this.delete(key);
					return;
				}
				this.prune();
			},
			() => {
				if (this.entries.get(key) === entry) this.delete(key);
			},
		);
	}
	delete(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.bytes -= entry.bytes;
		return this.entries.delete(key);
	}
	clear() {
		this.entries.clear();
		this.bytes = 0;
	}
	private prune() {
		while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
			const first = this.entries.keys().next().value;
			if (first === undefined) break;
			this.delete(first);
		}
	}
}
