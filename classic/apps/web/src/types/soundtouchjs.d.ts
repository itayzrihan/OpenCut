declare module "soundtouchjs" {
	export class SoundTouch {
		tempo: number;
		readonly stretch: {
			setParameters(
				sampleRate: number,
				sequenceMs: number,
				seekWindowMs: number,
				overlapMs: number,
			): void;
		};
	}
	export class SimpleFilter {
		constructor(
			source: {
				extract(target: Float32Array, count: number, position: number): number;
			},
			pipe: SoundTouch,
		);
		readonly sourcePosition: number;
		extract(target: Float32Array, count: number): number;
	}
}
