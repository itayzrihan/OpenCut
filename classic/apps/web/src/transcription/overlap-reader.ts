/** Reuse only the shared PCM context. Model context and word boundaries stay intact. */
export function reuseAudioContext({
	read,
	sampleRate = 16000,
	contextSeconds = 10,
}: {
	read: (range: { start: number; end: number }) => Promise<Float32Array>;
	sampleRate?: number;
	contextSeconds?: number;
}) {
	let tail: Float32Array | undefined;
	let tailStart = 0;
	let tailEnd = 0;
	return async ({ start, end }: { start: number; end: number }) => {
		const overlapEnd =
			tail && start >= tailStart && start < tailEnd
				? Math.min(end, tailEnd)
				: start;
		const offset = Math.round((overlapEnd - start) * sampleRate);
		const output = new Float32Array(Math.ceil((end - start) * sampleRate));
		if (offset && tail) {
			const from = Math.round((start - tailStart) * sampleRate);
			output.set(tail.subarray(from, from + offset));
		}
		if (overlapEnd < end) {
			const samples = await read({ start: overlapEnd, end });
			output.set(samples.subarray(0, output.length - offset), offset);
		}
		// Copy at most 640 KB; never retain an episode or a transferred buffer.
		tail = output.slice(
			Math.max(0, output.length - contextSeconds * sampleRate),
		);
		tailEnd = end;
		tailStart = end - tail.length / sampleRate;
		return output;
	};
}
