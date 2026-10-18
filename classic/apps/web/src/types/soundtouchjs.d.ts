declare module "soundtouchjs" {
	export class SoundTouch {
		tempo: number;
		pitch: number;
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
	export class PitchShifter {
		constructor(
			context: BaseAudioContext,
			buffer: AudioBuffer,
			bufferSize: number,
			onEnd?: () => void,
		);
		tempo: number;
		pitch: number;
		connect(destination: AudioNode): void;
		off(): void;
	}
}
