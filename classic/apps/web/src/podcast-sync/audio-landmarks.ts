// A compact time/frequency signature for seeking; waveform verification decides placement.
const FFT = 256;
const HOP = 128;
const RATE = 4000;
const FRAME_SECONDS = HOP / RATE;
const FFT_COS = Float64Array.from({ length: FFT / 2 }, (_, i) =>
	Math.cos((-2 * Math.PI * i) / FFT),
);
const FFT_SIN = Float64Array.from({ length: FFT / 2 }, (_, i) =>
	Math.sin((-2 * Math.PI * i) / FFT),
);
const TAPER = Float64Array.from(
	{ length: FFT },
	(_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT),
);
const REVERSE = Uint8Array.from({ length: FFT }, (_, i) => {
	let reverse = 0;
	for (let bit = 0; bit < 8; bit++) reverse = reverse * 2 + ((i >> bit) & 1);
	return reverse;
});

export class AudioLandmarks {
	private frame = new Float64Array(FFT);
	private real = new Float64Array(FFT);
	private imaginary = new Float64Array(FFT);
	private power = new Float64Array(FFT / 2);
	private positions: Array<[number, number] | undefined> = Array.from({
		length: 12,
	});
	private values: number[] = [];
	private cursor = 0;
	private frameIndex = 0;
	private sampleSum = 0;
	private sampleCount = 0;

	// Both host readers supply 16 kHz mono. Average four consecutive samples.
	push(value: number) {
		this.sampleSum += value;
		if (++this.sampleCount !== 4) return;
		this.frame[this.cursor++] = this.sampleSum / 4;
		this.sampleSum = 0;
		this.sampleCount = 0;
		if (this.cursor !== FFT) return;
		this.recordFrame();
		this.frame.copyWithin(0, HOP);
		this.cursor = FFT - HOP;
	}

	finish() {
		return Float32Array.from(this.values);
	}

	private recordFrame() {
		const { frame, real, imaginary, power } = this;
		for (let i = 0; i < FFT; i++) {
			real[REVERSE[i]!] = frame[i]! * TAPER[i]!;
			imaginary[i] = 0;
		}
		for (let width = 2; width <= FFT; width *= 2) {
			const half = width / 2;
			for (let base = 0; base < FFT; base += width) {
				for (let j = 0; j < half; j++) {
					const root = j * (FFT / width);
					const a = base + j,
						b = a + half;
					const x = real[b]! * FFT_COS[root]! - imaginary[b]! * FFT_SIN[root]!;
					const y = real[b]! * FFT_SIN[root]! + imaginary[b]! * FFT_COS[root]!;
					real[b] = real[a]! - x;
					imaginary[b] = imaginary[a]! - y;
					real[a] = real[a]! + x;
					imaginary[a] = imaginary[a]! + y;
				}
			}
		}
		for (let i = 8; i < 122; i++) power[i] = real[i]! ** 2 + imaginary[i]! ** 2;
		let first = 0,
			second = 0;
		for (let i = 9; i < 121; i++) {
			if (power[i]! <= power[i - 1]! || power[i]! <= power[i + 1]!) continue;
			if (power[i]! > power[first]!) {
				second = first;
				first = i;
			} else if (power[i]! > power[second]!) second = i;
		}
		const index = this.frameIndex++;
		this.positions[index % this.positions.length] =
			power[first]! > 0.001
				? [Math.round(first / 2), Math.round(second / 2)]
				: undefined;
		if (index % 2 !== 0 || power[first]! <= 0.001) return;
		for (const delta of [5, 10]) {
			if (index < delta) continue;
			const previous = this.positions[(index - delta) % this.positions.length];
			if (!previous) continue;
			const hash = (previous[0] * 64 + Math.round(first / 2)) * 16 + delta;
			this.values.push(hash, (index - delta) * FRAME_SECONDS);
			if (previous[1] && second && delta === 5) {
				const secondary =
					(previous[1] * 64 + Math.round(second / 2)) * 16 + delta;
				if (secondary !== hash)
					this.values.push(secondary, (index - delta) * FRAME_SECONDS);
			}
		}
	}
}

export function buildLandmarkIndex(reference: Float32Array) {
	const index = new Map<number, number[] | null>();
	for (let i = 0; i < reference.length; i += 2) {
		const hash = reference[i]!;
		const times = index.get(hash);
		if (times === null) continue;
		if (!times) index.set(hash, [reference[i + 1]!]);
		else if (times.length >= 64) index.set(hash, null);
		else times.push(reference[i + 1]!);
	}
	return index;
}

export function rankLandmarkOffsets({
	index,
	probes,
}: {
	index: ReadonlyMap<number, readonly number[] | null>;
	probes: { at: number; landmarks: Float32Array }[];
}) {
	const votes = new Map<number, { count: number; probes: Set<number> }>();
	for (const { at, landmarks } of probes) {
		for (let i = 0; i < landmarks.length; i += 2) {
			const times = index.get(landmarks[i]!);
			if (!times) continue;
			const query = at + landmarks[i + 1]!;
			for (const time of times) {
				const key = Math.round((time - query) / 0.128);
				const vote = votes.get(key) ?? { count: 0, probes: new Set<number>() };
				vote.count++;
				vote.probes.add(at);
				votes.set(key, vote);
			}
		}
	}
	return [...votes]
		.filter(([, evidence]) => evidence.count >= 5)
		.sort(
			(a, b) => b[1].probes.size - a[1].probes.size || b[1].count - a[1].count,
		)
		.slice(0, 5)
		.map(([bucket]) => bucket * 0.128);
}
