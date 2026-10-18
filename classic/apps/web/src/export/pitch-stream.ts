import { SimpleFilter, SoundTouch } from "soundtouchjs";
import { clampRetimeRate } from "@/retime/rate";

/** Keep SoundTouch's existing DSP state across disk windows. Resetting a
 * PitchShifter every two seconds causes phase jumps in long retimed clips. */
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
	signal: AbortSignal;
}): AsyncGenerator<AudioBuffer> {
	const rate = clampRetimeRate({ rate: requestedRate }),
		sr = context.sampleRate;
	const sourceLength = Math.ceil(duration * rate * sr),
		outputLength = Math.ceil(duration * sr);
	const trim = Math.floor(trimStart * sr) / sr;
	const dsp = new SoundTouch();
	dsp.tempo = rate;
	dsp.pitch = 1;
	let cache: AudioBuffer | undefined,
		cacheFirst = 0,
		cacheOffset = 0;
	const filter = new SimpleFilter(
		{
			extract(target, count, position) {
				const actual = Math.max(0, Math.min(count, sourceLength - position));
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
				return actual;
			},
		},
		dsp,
	);
	const interleaved = new Float32Array(4096 * 2);
	for (let first = 0; first < outputLength; first += 4096) {
		signal.throwIfAborted();
		// Match the existing 4096-frame ScriptProcessor's two-buffer latency.
		// Keep it once at the clip start, never once per disk window.
		if (first < 8192) {
			yield context.createBuffer(2, Math.min(4096, outputLength - first), sr);
			continue;
		}
		// SimpleFilter consumes 16k input blocks. Cover its worst case for one
		// output block, then read ahead with a fixed cap, independent of duration.
		if (
			!cache ||
			filter.sourcePosition + 65536 > cacheFirst + cache.length - cacheOffset
		) {
			cacheFirst = filter.sourcePosition;
			const decoded = await readSource(
				trim + cacheFirst / sr,
				trim + (cacheFirst + 131072) / sr,
			);
			cache = decoded.buffer;
			cacheOffset = Math.round(decoded.trimStart * sr);
		}
		const extracted = filter.extract(interleaved, 4096),
			count = Math.min(4096, outputLength - first);
		const output = context.createBuffer(2, count, sr);
		for (let ch = 0; ch < 2; ch++) {
			const dest = output.getChannelData(ch);
			for (let i = 0; i < Math.min(count, extracted); i++)
				dest[i] = interleaved[i * 2 + ch];
		}
		yield output;
	}
}
