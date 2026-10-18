import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "./source";

/** One demuxer per source, shared by streaming and short Smart Takes ranges. */
export class AudioSinkCache {
	private entries = new Map<
		string,
		{
			input: Input;
			ready: Promise<AudioBufferSink | null>;
			codec?: string | null;
			sampleRate?: number;
		}
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
			source: createMediaSource({
				...source,
				urlOptions: { maxCacheSize: 8 * 1024 ** 2, ...source.urlOptions },
			}),
			formats: ALL_FORMATS,
		});
		const entry: {
			input: Input;
			ready: Promise<AudioBufferSink | null>;
			codec?: string | null;
			sampleRate?: number;
		} = {
			input,
			ready: Promise.resolve<AudioBufferSink | null>(null),
		};
		entry.ready = input
			.getPrimaryAudioTrack()
			.then((track) => {
				if (this.entries.get(sourceKey) !== entry) return null;
				if (track) {
					entry.codec = track.codec;
					entry.sampleRate = track.sampleRate;
					return new AudioBufferSink(track);
				}
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

	/** Compressed codecs need decoder priming; resampling needs filter handles. */
	canReadIndependentRanges({
		sourceKey,
		sampleRate,
	}: {
		sourceKey: string;
		sampleRate: number;
	}): boolean {
		const entry = this.entries.get(sourceKey);
		return (
			entry?.codec?.startsWith("pcm-") === true &&
			entry.sampleRate === sampleRate
		);
	}

	clear(): void {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const { input } of entries) input.dispose();
	}
}
