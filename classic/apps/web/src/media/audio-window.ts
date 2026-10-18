/** Bounded browser decoder. Seeking and resampling are host IO, not editor state. */
import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "./source";

export const AUDIO_WINDOW_LIMIT_SECONDS = 90;
export const SPEECH_SAMPLE_RATE = 16000;

export async function openAudioWindowReader({
	asset,
	signal,
}: {
	asset: BrowserMediaSource;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	const input = new Input({
		formats: ALL_FORMATS,
		source: createMediaSource({
			...asset,
			urlOptions: { maxCacheSize: 8 * 1024 ** 2, parallelism: 1 },
		}),
	});
	const abort = () => input.dispose();
	signal.addEventListener("abort", abort, { once: true });
	const close = () => {
		signal.removeEventListener("abort", abort);
		input.dispose();
	};
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("The source has no audio track");
		const rate = track.sampleRate;
		if (!Number.isFinite(rate) || rate < 8000 || rate > 192000)
			throw new Error("Unsupported source audio sample rate");
		const sink = new AudioBufferSink(track);
		return {
			duration: () => track.computeDuration(),
			close,
			async read({
				start,
				end,
				missing = "silence",
				channelMix = "average",
			}: {
				start: number;
				end: number;
				missing?: "silence" | "unknown";
				channelMix?: "average" | "max-magnitude";
			}) {
				signal.throwIfAborted();
				if (
					!Number.isFinite(start) ||
					!Number.isFinite(end) ||
					start < 0 ||
					end <= start ||
					end - start > AUDIO_WINDOW_LIMIT_SECONDS
				)
					throw new Error(
						"Audio decoding requires a finite window of at most 90 seconds",
					);
				const frames = Math.ceil((end - start) * SPEECH_SAMPLE_RATE);
				const context = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE);
				const source = context.createBuffer(
					1,
					Math.ceil((end - start) * rate),
					rate,
				);
				const mono = source.getChannelData(0);
				const covered =
					missing === "unknown" ? new Uint8Array(frames) : undefined;
				for await (const chunk of sink.buffers(start, end)) {
					signal.throwIfAborted();
					if (chunk.buffer.sampleRate !== rate)
						throw new Error("Audio sample rate changed while decoding");
					const at = Math.round((chunk.timestamp - start) * rate);
					const first = Math.max(0, -at);
					const last = Math.min(chunk.buffer.length, mono.length - at);
					const channels = Array.from(
						{ length: chunk.buffer.numberOfChannels },
						(_, i) => chunk.buffer.getChannelData(i),
					);
					for (let i = first; i < last; i++) {
						let value = 0;
						for (const channel of channels) {
							const v = channel[i];
							if (!Number.isFinite(v)) {
								value = NaN;
								break;
							}
							value =
								channelMix === "average"
									? value + v / channels.length
									: Math.abs(v) > Math.abs(value)
										? v
										: value;
						}
						mono[at + i] = value;
					}
					if (covered && last > first)
						covered.fill(
							1,
							Math.floor(((at + first) * SPEECH_SAMPLE_RATE) / rate),
							Math.ceil(((at + last) * SPEECH_SAMPLE_RATE) / rate),
						);
				}
				const node = context.createBufferSource();
				node.buffer = source;
				node.connect(context.destination);
				node.start();
				let result: Float32Array;
                try {
                    result = (await context.startRendering()).getChannelData(0);
                } finally {
                    node.disconnect();
                    node.buffer = null;
                }
				signal.throwIfAborted();
				if (covered)
					for (let i = 0; i < result.length; i++)
						if (!covered[i]) result[i] = NaN;
				return result;
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}
