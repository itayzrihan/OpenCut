import { describe, expect, test } from "bun:test";
import type { AudioElement } from "@/timeline/types";
import {
	buildCompactWaveformGainSamples,
	buildCompactWaveformGainSamplesFromState,
	dBToLinear,
	hasVariableAudioGain,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import {
	mediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm/media-time";

function audioElement({
	volume = 0,
	muted = false,
	hasAnimatedVolume = false,
	fadeInDuration = 0,
	fadeOutDuration = 0,
}: {
	volume?: number;
	muted?: boolean;
	hasAnimatedVolume?: boolean;
	fadeInDuration?: number;
	fadeOutDuration?: number;
} = {}): AudioElement {
	return {
		id: "audio-1",
		name: "Audio 1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: TICKS_PER_SECOND }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			fadeInDuration,
			fadeOutDuration,
			volume,
			muted,
		},
		animations: hasAnimatedVolume
			? {
					volume: {
						keys: [
							{
								id: "volume-start",
								time: ZERO_MEDIA_TIME,
								value: 0,
								segmentToNext: "linear",
								tangentMode: "auto",
							},
							{
								id: "volume-end",
								time: mediaTime({ ticks: TICKS_PER_SECOND }),
								value: -6,
								segmentToNext: "linear",
								tangentMode: "auto",
							},
						],
					},
				}
			: undefined,
	};
}

describe("compact waveform gain samples", () => {
	test("omits gain samples for the default unmuted 0 dB envelope", () => {
		expect(
			buildCompactWaveformGainSamples({
				element: audioElement(),
				count: 4,
			}),
		).toBeUndefined();
	});

	test("uses one sample for muted or constant-volume clips", () => {
		expect(
			buildCompactWaveformGainSamples({
				element: audioElement({ muted: true }),
				count: 4,
			}),
		).toEqual([0]);

		expect(
			buildCompactWaveformGainSamples({
				element: audioElement({ volume: -6 }),
				count: 4,
			}),
		).toEqual([dBToLinear(-6)]);
	});

	test("keeps full samples for animated volume envelopes", () => {
		const samples = buildCompactWaveformGainSamples({
			element: audioElement({ hasAnimatedVolume: true }),
			count: 4,
		});

		expect(samples).toHaveLength(4);
		expect(samples?.[0]).toBeGreaterThan(samples?.[3] ?? 0);
	});

	test("matches element-based samples when called from scalar timeline state", () => {
		const element = audioElement({ volume: -6, hasAnimatedVolume: true });

		expect(
			buildCompactWaveformGainSamplesFromState({
				animations: element.animations,
				count: 4,
				duration: element.duration,
				fadeInDuration: element.params.fadeInDuration,
				fadeOutDuration: element.params.fadeOutDuration,
				muted: element.params.muted === true,
				volume: element.params.volume,
			}),
		).toEqual(buildCompactWaveformGainSamples({ element, count: 4 }));
	});

	test("includes fade durations in compact waveform gain samples", () => {
		const samples = buildCompactWaveformGainSamples({
			element: audioElement({ fadeInDuration: 0.5, fadeOutDuration: 0.5 }),
			count: 4,
		});

		expect(samples).toHaveLength(4);
		expect(samples?.[0]).toBeLessThan(samples?.[1] ?? 0);
		expect(samples?.[3]).toBeLessThan(samples?.[2] ?? 0);
	});
});

describe("audio fades", () => {
	test("resolve gain ramps in and out across fade durations", () => {
		const element = audioElement({
			fadeInDuration: 0.5,
			fadeOutDuration: 0.25,
		});

		expect(resolveEffectiveAudioGain({ element, localTime: 0 })).toBe(0);
		expect(resolveEffectiveAudioGain({ element, localTime: 0.25 })).toBeCloseTo(
			0.5,
		);
		expect(resolveEffectiveAudioGain({ element, localTime: 0.5 })).toBeCloseTo(
			1,
		);
		expect(
			resolveEffectiveAudioGain({ element, localTime: 0.875 }),
		).toBeCloseTo(0.5);
		expect(resolveEffectiveAudioGain({ element, localTime: 1 })).toBe(0);
	});

	test("marks fade-only clips as variable-gain audio", () => {
		expect(
			hasVariableAudioGain({ element: audioElement({ fadeInDuration: 0.25 }) }),
		).toBe(true);
		expect(hasVariableAudioGain({ element: audioElement() })).toBe(false);
	});
});
