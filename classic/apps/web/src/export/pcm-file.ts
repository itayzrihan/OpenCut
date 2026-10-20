/* eslint-disable opencut/prefer-object-params -- Internal filesystem adapters mirror platform handle, buffer and offset APIs. */
/** Interleaved float PCM in job-owned storage. Only bounded windows enter the decoder. */
export interface PcmWriter {
	write(data: {
		type: "write";
		position: number;
		data: Uint8Array<ArrayBuffer>;
	}): Promise<void>;
	truncate(size: number): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}
export interface PcmStorage {
	createWritable(): Promise<PcmWriter>;
	getFile(): Promise<File>;
}
export class PcmFile {
	private snapshot?: File;
	private writer?: PcmWriter;
	private pending = new Uint8Array(0);
	private pendingLength = 0;
	private pendingStart = 0;
	frames = 0;
	constructor(
		readonly handle: PcmStorage,
		readonly sampleRate: number,
		readonly channels: number,
	) {}

	async open(): Promise<void> {
		this.writer = await this.handle.createWritable();
		this.pending = new Uint8Array(512 * 1024);
	}

	async write(
		buffer: AudioBuffer,
		startFrame: number,
		sourceStart = 0,
		count = buffer.length - sourceStart,
	): Promise<void> {
		if (!this.writer) throw new Error("PCM file is not open");
		if (
			!Number.isSafeInteger(startFrame) ||
			startFrame < 0 ||
			sourceStart < 0 ||
			count < 0 ||
			sourceStart + count > buffer.length
		)
			throw new Error("Invalid PCM write range");
		// Even a decoder that returns a very large buffer cannot create a second
		// unbounded interleaved allocation or an unbounded write queue.
		for (let offset = 0; offset < count; offset += 16384) {
			const length = Math.min(16384, count - offset);
			const data = new Float32Array(length * this.channels);
			for (let channel = 0; channel < this.channels; channel++) {
				const source = buffer.getChannelData(
					Math.min(channel, buffer.numberOfChannels - 1),
				);
				for (let i = 0; i < length; i++)
					data[i * this.channels + channel] = source[sourceStart + offset + i];
			}
			await this.append(
				new Uint8Array(data.buffer),
				(startFrame + offset) * this.channels * 4,
			);
		}
		this.frames = Math.max(this.frames, startFrame + count);
	}

	private async flush(): Promise<void> {
		if (!this.pendingLength || !this.writer) return;
		await this.writer.write({
			type: "write",
			position: this.pendingStart,
			data: this.pending.subarray(0, this.pendingLength),
		});
		this.pendingLength = 0;
	}

	private async append(data: Uint8Array, position: number): Promise<void> {
		if (
			this.pendingLength &&
			position !== this.pendingStart + this.pendingLength
		)
			await this.flush();
		for (let offset = 0; offset < data.length; ) {
			if (!this.pendingLength) this.pendingStart = position + offset;
			const count = Math.min(
				data.length - offset,
				this.pending.length - this.pendingLength,
			);
			this.pending.set(
				data.subarray(offset, offset + count),
				this.pendingLength,
			);
			this.pendingLength += count;
			offset += count;
			if (this.pendingLength === this.pending.length) await this.flush();
		}
	}

	async seal(minimumFrames = this.frames): Promise<void> {
		if (!this.writer) throw new Error("PCM file is not open");
		await this.flush();
		this.frames = Math.max(this.frames, minimumFrames);
		await this.writer.truncate(this.frames * this.channels * 4);
		await this.writer.close();
		this.writer = undefined;
		this.pending = new Uint8Array(0);
		this.snapshot = await this.handle.getFile();
	}

	async read(
		context: BaseAudioContext,
		startFrame: number,
		length: number,
	): Promise<AudioBuffer> {
		if (!this.snapshot) throw new Error("PCM file is not sealed");
		if (
			!Number.isSafeInteger(startFrame) ||
			!Number.isSafeInteger(length) ||
			length <= 0 ||
			length > this.sampleRate * 120
		)
			throw new Error("Export audio window exceeds the memory budget");
		const output = context.createBuffer(this.channels, length, this.sampleRate);
		const first = Math.max(0, startFrame);
		const last = Math.min(this.frames, startFrame + length);
		if (last <= first) return output;
		const readWindow = () =>
			this.snapshot!.slice(
				first * this.channels * 4,
				last * this.channels * 4,
			).arrayBuffer();
		let bytes: ArrayBuffer;
		try {
			bytes = await readWindow();
		} catch (error) {
			// Chromium can invalidate an OPFS File snapshot while its handle is
			// still valid. Refresh only that sealed, job-owned file, once. Never
			// retry changed-length PCM or restart the complete transcription.
			if (
				!(error instanceof DOMException) ||
				!["NotReadableError", "InvalidStateError"].includes(error.name)
			)
				throw error;
			const fresh = await this.handle.getFile();
			if (fresh.size !== this.frames * this.channels * 4)
				throw new Error(
					"Sealed audio scratch file changed size; retry this saved edit",
				);
			this.snapshot = fresh;
			bytes = await readWindow();
		}
		const data = new Float32Array(bytes);
		for (let channel = 0; channel < this.channels; channel++) {
			const dest = output.getChannelData(channel);
			for (let i = 0; i < last - first; i++)
				dest[first - startFrame + i] = data[i * this.channels + channel];
		}
		return output;
	}

	async abort(): Promise<void> {
		await this.writer?.abort().catch(() => undefined);
		this.writer = undefined;
		this.pending = new Uint8Array(0);
		this.snapshot = undefined;
	}
}
