import type { EarshotSpec } from "../types";

/** Replace only synthesis: the integration test exercises real browser audio,
 * source windows, scratch PCM, retiming, clip gain and the export mixer. */
export const synthesized: number[] = [];

export function fixtureChannels(spec: EarshotSpec): Float32Array[] {
	return [1, -0.7].map((channel) =>
		Float32Array.from({ length: Math.round(spec.duration * 48000) }, (_, i) => {
			const t = i / 48000;
			return (
				channel *
				(0.12 + t * 0.01) *
				Math.sin(t * 2 * Math.PI * (200 + spec.seed))
			);
		}),
	);
}

export async function renderEarshotSound({
	spec,
	signal,
}: {
	spec: EarshotSpec;
	signal?: AbortSignal;
}) {
	signal?.throwIfAborted();
	if (spec.sourceCode === "invalid")
		throw new Error("Fixture synthesis failed");
	synthesized.push(spec.seed);
	return { channels: fixtureChannels(spec), sampleRate: 48000 };
}
