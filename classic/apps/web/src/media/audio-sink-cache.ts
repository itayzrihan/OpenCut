import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "./source";

/** One demuxer per source, shared by streaming and short Smart Takes ranges. */
export class AudioSinkCache {
	private entries = new Map<
		string,
		{ input: Input; ready: Promise<AudioBufferSink | null> }
	>();

	get({
		sourceKey,
		...source
	}: BrowserMediaSource & {
		sourceKey: string;
	}): Promise<AudioBufferSink | null> {
		const existing = this.entries.get(sourceKey);
		if (existing) return existing.ready;
		const input = new Input({
			source: createMediaSource(source),
			formats: ALL_FORMATS,
		});
		const entry = {
			input,
			ready: Promise.resolve<AudioBufferSink | null>(null),
		};
		entry.ready = input
			.getPrimaryAudioTrack()
			.then((track) => {
				if (this.entries.get(sourceKey) !== entry) return null;
				if (track) return new AudioBufferSink(track);
				this.entries.delete(sourceKey);
				input.dispose();
				return null;
			})
			.catch((error: unknown) => {
				if (this.entries.get(sourceKey) === entry) {
					this.entries.delete(sourceKey);
					input.dispose();
				}
				throw error;
			});
		this.entries.set(sourceKey, entry);
		return entry.ready;
	}

	clear(): void {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const { input } of entries) input.dispose();
	}
}
