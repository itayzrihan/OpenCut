import { SimpleFilter, SoundTouch } from "soundtouchjs";
import { clampRetimeRate } from "@/retime/rate";

const OUTPUT_BLOCK_FRAMES = 4096;
const SOURCE_CACHE_FRAMES = 131072;
const SOURCE_LOOKAHEAD_FRAMES = 65536;

/** Render an aligned clip while retaining DSP state across source windows. */
export async function* streamPitchPreserved({
	context,
	trimStart,
	duration,
	rate: requestedRate,
	readSource,
	signal,
}: {
	context: BaseAudioContext;
	trimStart: number;
	duration: number;
	rate: number;
	readSource: (
		start: number,
		end: number,
	) => Promise<{ buffer: AudioBuffer; trimStart: number }>;
	signal?: AbortSignal;
}): AsyncGenerator<AudioBuffer> {
	const rate = clampRetimeRate({ rate: requestedRate }),
		sr = context.sampleRate;
	const sourceLength = Math.ceil(duration * rate * sr),
		outputLength = Math.ceil(duration * sr);
	const trim = Math.floor(trimStart * sr) / sr;
	const dsp = new SoundTouch();
	dsp.stretch.setParameters(sr, 0, 0, 8);
	dsp.tempo = rate;
	let cache: AudioBuffer | undefined,
		cacheFirst = 0,
		cacheOffset = 0;
	const filter = new SimpleFilter(
		{
			extract(target, count, position) {
				const actual = Math.max(0, Math.min(count, sourceLength - position));
				if (actual) {
					if (
						!cache ||
						position < cacheFirst ||
						position + actual > cacheFirst + cache.length - cacheOffset
					)
						throw new Error("Pitch input window exceeded its memory budget");
					for (let ch = 0; ch < 2; ch++) {
						const src = cache.getChannelData(
							Math.min(ch, cache.numberOfChannels - 1),
						);
						for (let i = 0; i < actual; i++)
							target[i * 2 + ch] = src[cacheOffset + position - cacheFirst + i];
					}
				}
				// SimpleFilter will stop on a partial input block. Pad the final
				// block to flush the clip without reading audio beyond its trim.
				target.fill(0, actual * 2);
				return count;
			},
		},
		dsp,
	);
	const interleaved = new Float32Array(OUTPUT_BLOCK_FRAMES * 2);
	for (let first = 0; first < outputLength; first += OUTPUT_BLOCK_FRAMES) {
		signal?.throwIfAborted();
		const position = filter.sourcePosition;
		if (
			position < sourceLength &&
			(!cache ||
				Math.min(sourceLength, position + SOURCE_LOOKAHEAD_FRAMES) >
					cacheFirst + cache.length - cacheOffset)
		) {
			cacheFirst = position;
			const decoded = await readSource(
				trim + cacheFirst / sr,
				trim + Math.min(sourceLength, cacheFirst + SOURCE_CACHE_FRAMES) / sr,
			);
			signal?.throwIfAborted();
			cache = decoded.buffer;
			cacheOffset = Math.round(decoded.trimStart * sr);
		}
		const count = Math.min(OUTPUT_BLOCK_FRAMES, outputLength - first);
		if (filter.extract(interleaved, count) !== count)
			throw new Error("Pitch-preserving audio ended before the clip boundary");
		const output = context.createBuffer(2, count, sr);
		for (let ch = 0; ch < 2; ch++) {
			const dest = output.getChannelData(ch);
			for (let i = 0; i < count; i++) dest[i] = interleaved[i * 2 + ch];
		}
		yield output;
	}
}
