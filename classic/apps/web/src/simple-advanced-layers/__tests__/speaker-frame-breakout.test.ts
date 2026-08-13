import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	EffectElement,
	SceneTracks,
	VideoElement,
} from "@/timeline/types";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
	buildSpeakerFrameBackgroundSnapshot,
	buildSpeakerFrameLegacySourceSignature,
	buildSpeakerFrameLegacySourceSignatures,
	buildSpeakerFrameMatteSampleTimes,
	buildSpeakerFrameMatteCacheKey,
	buildSpeakerFrameSourceSignature,
	getSpeakerFrameSourceCoverageGap,
	getSpeakerFrameSourceBindings,
	hasUnsupportedSpeakerFramePerspective,
	isSpeakerFrameBreakoutAppliedAndCurrent,
	readSpeakerFrameBreakoutFade,
	readSpeakerFrameBreakoutSettings,
	resolveSpeakerFrameSourceAtTime,
	speakerFrameLayoutScale,
} from "../speaker-frame-breakout";

const ticks = (value: number) => mediaTime({ ticks: value });

function video({
	id,
	mediaId,
	startTime,
	duration,
	trimStart = 0,
}: {
	id: string;
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: ticks(startTime),
		duration: ticks(duration),
		trimStart: ticks(trimStart),
		trimEnd: ticks(0),
		params: {},
	};
}

function layer(params = SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS): EffectElement {
	return {
		id: "smart",
		type: "effect",
		effectType: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		name: "Speaker Frame Breakout",
		startTime: ticks(100),
		duration: ticks(400),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: { ...params },
	};
}

function tracks(): SceneTracks {
	return {
		overlay: [
			{
				id: "smart-track",
				name: "Smart",
				type: "effect",
				hidden: false,
				elements: [layer()],
			},
			{
				id: "near-video",
				name: "Near video",
				type: "video",
				hidden: false,
				muted: false,
				elements: [
					video({
						id: "near-a",
						mediaId: "media-a",
						startTime: 100,
						duration: 180,
					}),
				],
			},
		],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			hidden: false,
			muted: false,
			elements: [
				video({
					id: "main-a",
					mediaId: "media-b",
					startTime: 100,
					duration: 400,
				}),
			],
		},
		audio: [],
		order: ["smart-track", "near-video", "main"],
	};
}

const assets: MediaAsset[] = [
	{
		id: "media-a",
		name: "A.mp4",
		type: "video",
		duration: 10,
		url: "blob:a",
	},
	{
		id: "media-b",
		name: "B.mp4",
		type: "video",
		duration: 10,
		url: "blob:b",
	},
];

describe("Speaker Frame Breakout smart-layer model", () => {
	test("preserves source mirror direction while applying smart layout scale", () => {
		expect(
			speakerFrameLayoutScale({ layoutScale: 0.7, sourceScale: -1.25 }),
		).toBe(-0.7);
		expect(
			speakerFrameLayoutScale({ layoutScale: 0.7, sourceScale: 1.25 }),
		).toBe(0.7);
	});

	test("rejects source perspective that cannot share the breakout masks", () => {
		const source = video({
			id: "perspective",
			mediaId: "media-a",
			startTime: 0,
			duration: 100,
		});
		expect(hasUnsupportedSpeakerFramePerspective({ source })).toBe(false);
		source.params["transform.perspectiveX"] = 8;
		expect(hasUnsupportedSpeakerFramePerspective({ source })).toBe(true);
	});

	test("binds to the nearest active video below and falls through across cuts", () => {
		const sceneTracks = tracks();
		const smartLayer = layer();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: smartLayer,
		});

		expect(bindings.map((binding) => binding.element.id)).toEqual([
			"near-a",
			"main-a",
		]);
		expect(
			resolveSpeakerFrameSourceAtTime({
				bindings,
				time: ticks(150),
			})?.element.id,
		).toBe("near-a");
		expect(
			resolveSpeakerFrameSourceAtTime({
				bindings,
				time: ticks(350),
			})?.element.id,
		).toBe("main-a");
	});

	test("detects exact source coverage gaps instead of sampling past them", () => {
		const smartLayer = layer();
		const completeBindings = getSpeakerFrameSourceBindings({
			tracks: tracks(),
			smartTrackId: "smart-track",
			layer: smartLayer,
		});
		expect(
			getSpeakerFrameSourceCoverageGap({
				bindings: completeBindings,
				layer: smartLayer,
			}),
		).toBeNull();
		expect(
			getSpeakerFrameSourceCoverageGap({
				bindings: completeBindings.filter(
					(binding) => binding.element.id !== "main-a",
				),
				layer: smartLayer,
			}),
		).toEqual({
			startTime: ticks(280),
			endTime: ticks(500),
		});
	});

	test("plans every quantized source bin for fast retime and both endpoints", () => {
		const smartLayer = {
			...layer(),
			startTime: ticks(0),
			duration: mediaTimeFromSeconds({ seconds: 1 }),
		};
		const source = video({
			id: "fast",
			mediaId: "media-a",
			startTime: 0,
			duration: smartLayer.duration,
		});
		source.retime = { rate: 2 };
		const sampleTimes = buildSpeakerFrameMatteSampleTimes({
			bindings: [
				{
					trackId: "video",
					trackIndex: 1,
					element: source,
				},
			],
			layer: smartLayer,
			previewFps: 30,
		});
		const quantizedSourceBins = [
			...new Set(
				sampleTimes.map((time) =>
					Math.round(((time * 2) / 120_000) * 30),
				),
			),
		].sort((left, right) => left - right);

		expect(quantizedSourceBins).toEqual(
			Array.from({ length: 61 }, (_, index) => index),
		);
		expect(sampleTimes[0]).toBe(ticks(0));
		expect(sampleTimes.at(-1)).toBe(ticks(119_999));
	});

	test("invalidates mattes for source/range/tuning edits, not layout or background edits", () => {
		const sceneTracks = tracks();
		const smartLayer = layer();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: smartLayer,
		});
		const settings = readSpeakerFrameBreakoutSettings({
			params: smartLayer.params,
		});
		const initial = buildSpeakerFrameSourceSignature({
			layer: smartLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});
		const layoutOnly = readSpeakerFrameBreakoutSettings({
			params: {
				...smartLayer.params,
				positionY: 250,
				backgroundPresetId: "aurora",
				edgeFeather: 4,
			},
		});
		expect(
			buildSpeakerFrameSourceSignature({
				layer: smartLayer,
				bindings,
				mediaAssets: assets,
				settings: layoutOnly,
			}),
		).toBe(initial);
		expect(
			buildSpeakerFrameSourceSignature({
				layer: smartLayer,
				bindings: bindings.map((binding) => ({
					...binding,
					trackIndex: binding.trackIndex + 7,
				})),
				mediaAssets: assets.map((asset) => ({
					...asset,
					url: `blob:rehydrated-${asset.id}`,
				})),
				settings,
			}),
		).toBe(initial);

		const tuned = readSpeakerFrameBreakoutSettings({
			params: { ...smartLayer.params, maskThreshold: 0.6 },
		});
		expect(
			buildSpeakerFrameSourceSignature({
				layer: smartLayer,
				bindings,
				mediaAssets: assets,
				settings: tuned,
			}),
		).not.toBe(initial);
		expect(
			buildSpeakerFrameSourceSignature({
				layer: smartLayer,
				bindings,
				mediaAssets: assets.map((asset) =>
					asset.id === "media-a"
						? {
								...asset,
								fileName: "A-replaced.mp4",
								size: 123_456,
								lastModified: 1_785_225_600_000,
							}
						: asset,
				),
				settings,
			}),
		).not.toBe(initial);
		expect(
			buildSpeakerFrameSourceSignature({
				layer: smartLayer,
				bindings: bindings.map((binding, index) =>
					index === 0
						? {
								...binding,
								element: {
									...binding.element,
									animations: {
										opacity: {
											keys: [
												{
													id: "opacity-key",
													time: ticks(10),
													value: 0.8,
													segmentToNext: "linear",
													tangentMode: "auto",
												},
											],
										},
									},
								},
							}
						: binding,
				),
				mediaAssets: assets,
				settings,
			}),
		).not.toBe(initial);
	});

	test("recognizes only the exact applied snapshot as current", () => {
		const sceneTracks = tracks();
		const baseLayer = layer();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: baseLayer,
		});
		const settings = readSpeakerFrameBreakoutSettings({
			params: baseLayer.params,
		});
		const signature = buildSpeakerFrameSourceSignature({
			layer: baseLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});
		const appliedLayer = layer({
			...baseLayer.params,
			matteApplied: true,
			matteCacheKey: buildSpeakerFrameMatteCacheKey({
				layerId: baseLayer.id,
				signature,
			}),
			sourceSignature: signature,
			appliedStartTime: baseLayer.startTime,
			appliedDuration: baseLayer.duration,
		});
		expect(
			isSpeakerFrameBreakoutAppliedAndCurrent({
				layer: appliedLayer,
				signature,
			}),
		).toBe(true);
		expect(
			isSpeakerFrameBreakoutAppliedAndCurrent({
				layer: { ...appliedLayer, duration: ticks(401) },
				signature,
			}),
		).toBe(false);
	});

	test("accepts an exact legacy v4 snapshot during stable-signature migration", () => {
		const sceneTracks = tracks();
		const baseLayer = layer();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: baseLayer,
		});
		const settings = readSpeakerFrameBreakoutSettings({
			params: baseLayer.params,
		});
		const signature = buildSpeakerFrameSourceSignature({
			layer: baseLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});
		const legacySignature = buildSpeakerFrameLegacySourceSignature({
			layer: baseLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});
		const appliedLayer = layer({
			...baseLayer.params,
			matteApplied: true,
			matteCacheKey: buildSpeakerFrameMatteCacheKey({
				layerId: baseLayer.id,
				signature: legacySignature,
			}),
			sourceSignature: legacySignature,
			appliedStartTime: baseLayer.startTime,
			appliedDuration: baseLayer.duration,
		});

		expect(signature).toStartWith("sfb-v5-");
		expect(legacySignature).toStartWith("sfb-v4-");
		expect(
			isSpeakerFrameBreakoutAppliedAndCurrent({
				layer: appliedLayer,
				signature,
				legacySignatures: [legacySignature],
			}),
		).toBe(true);
	});

	test("accepts a legacy v4 snapshot after unrelated tracks shift every source index", () => {
		const sceneTracks = tracks();
		const baseLayer = layer();
		const originalBindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: baseLayer,
		});
		const settings = readSpeakerFrameBreakoutSettings({
			params: baseLayer.params,
		});
		const storedLegacySignature = buildSpeakerFrameLegacySourceSignature({
			layer: baseLayer,
			bindings: originalBindings,
			mediaAssets: assets,
			settings,
		});
		const shiftedBindings = originalBindings.map((binding) => ({
			...binding,
			trackIndex: binding.trackIndex + 3,
		}));
		const signature = buildSpeakerFrameSourceSignature({
			layer: baseLayer,
			bindings: shiftedBindings,
			mediaAssets: assets,
			settings,
		});
		const legacySignatures = buildSpeakerFrameLegacySourceSignatures({
			layer: baseLayer,
			bindings: shiftedBindings,
			mediaAssets: assets,
			settings,
			maxTrackIndexShift: 4,
		});
		const appliedLayer = layer({
			...baseLayer.params,
			matteApplied: true,
			matteCacheKey: buildSpeakerFrameMatteCacheKey({
				layerId: baseLayer.id,
				signature: storedLegacySignature,
			}),
			sourceSignature: storedLegacySignature,
			appliedStartTime: baseLayer.startTime,
			appliedDuration: baseLayer.duration,
		});

		expect(
			isSpeakerFrameBreakoutAppliedAndCurrent({
				layer: appliedLayer,
				signature,
				legacySignatures,
			}),
		).toBe(true);
	});

	test("snapshots every selected background parameter", () => {
		expect(
			buildSpeakerFrameBackgroundSnapshot({
				presetId: "custom",
				params: {
					preset: "waves",
					colorA: "#010101",
					colorB: "#020202",
					colorC: "#030303",
					density: 40,
					intensity: 50,
					scale: 60,
					seed: 9,
				},
			}),
		).toEqual({
			backgroundPresetId: "custom",
			backgroundPreset: "waves",
			backgroundColorA: "#010101",
			backgroundColorB: "#020202",
			backgroundColorC: "#030303",
			backgroundDensity: 40,
			backgroundIntensity: 50,
			backgroundScale: 60,
			backgroundSeed: 9,
		});
	});

	test("uses native fade transition metadata as the render source of truth", () => {
		const smartLayer = {
			...layer(),
			duration: mediaTimeFromSeconds({ seconds: 1 }),
			transitions: {
				in: {
					id: "in",
					presetId: "fade",
					placement: "in" as const,
					duration: mediaTimeFromSeconds({ seconds: 0.8 }),
					createdAt: "2026-07-28T00:00:00.000Z",
				},
				out: {
					id: "out",
					presetId: "fade",
					placement: "out" as const,
					duration: mediaTimeFromSeconds({ seconds: 0.7 }),
					createdAt: "2026-07-28T00:00:00.000Z",
				},
			},
		};

		expect(readSpeakerFrameBreakoutFade({ element: smartLayer })).toEqual({
			fadeInDuration: 0.5,
			fadeOutDuration: 0.5,
		});
	});
});
