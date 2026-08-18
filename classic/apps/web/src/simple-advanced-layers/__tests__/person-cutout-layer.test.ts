import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	EffectElement,
	SceneTracks,
	VideoElement,
} from "@/timeline/types";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getSpeakerFrameSourceBindings } from "../speaker-frame-breakout";
import {
	PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
	PERSON_CUTOUT_LAYER_EFFECT_TYPE,
	buildPersonCutoutLayerLegacySourceSignatures,
	buildPersonCutoutLayerMatteCacheKey,
	buildPersonCutoutLayerSourceSignature,
	isPersonCutoutLayerAppliedAndCurrent,
	isPersonCutoutLayerElement,
	readPersonCutoutLayerFade,
	readPersonCutoutLayerSettings,
} from "../person-cutout-layer";

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

function layer(params = PERSON_CUTOUT_LAYER_DEFAULT_PARAMS): EffectElement {
	return {
		id: "cutout",
		type: "effect",
		effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
		name: "Doubleman",
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
						duration: 400,
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
			elements: [],
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
];

describe("Person Cutout Layer smart-layer model", () => {
	test("recognizes only person-cutout-layer effect elements", () => {
		expect(isPersonCutoutLayerElement(layer())).toBe(true);
		expect(
			isPersonCutoutLayerElement({
				...layer(),
				effectType: "speaker-frame-breakout",
			}),
		).toBe(false);
	});

	test("defaults to a transparent (remove) background and reads mode from params", () => {
		const removeSettings = readPersonCutoutLayerSettings({
			params: PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
		});
		expect(removeSettings.backgroundMode).toBe("remove");
		expect(removeSettings.matte.mode).toBe("remove");

		const blurSettings = readPersonCutoutLayerSettings({
			params: { ...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS, backgroundMode: "blur" },
		});
		expect(blurSettings.backgroundMode).toBe("blur");
		expect(blurSettings.matte.mode).toBe("blur");

		const grayscaleSettings = readPersonCutoutLayerSettings({
			params: {
				...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
				backgroundMode: "grayscale",
			},
		});
		expect(grayscaleSettings.backgroundMode).toBe("grayscale");
		expect(grayscaleSettings.matte.mode).toBe("grayscale");
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

		expect(readPersonCutoutLayerFade({ element: smartLayer })).toEqual({
			fadeInDuration: 0.5,
			fadeOutDuration: 0.5,
		});
	});

	test("invalidates mattes for background-mode and tuning edits, not track-index shifts", () => {
		const sceneTracks = tracks();
		const smartLayer = layer();
		const bindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: smartLayer,
		});
		const settings = readPersonCutoutLayerSettings({
			params: smartLayer.params,
		});
		const initial = buildPersonCutoutLayerSourceSignature({
			layer: smartLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});

		expect(
			buildPersonCutoutLayerSourceSignature({
				layer: smartLayer,
				bindings: bindings.map((binding) => ({
					...binding,
					trackIndex: binding.trackIndex + 7,
				})),
				mediaAssets: assets,
				settings,
			}),
		).toBe(initial);

		const blurred = readPersonCutoutLayerSettings({
			params: { ...smartLayer.params, backgroundMode: "blur" },
		});
		expect(
			buildPersonCutoutLayerSourceSignature({
				layer: smartLayer,
				bindings,
				mediaAssets: assets,
				settings: blurred,
			}),
		).not.toBe(initial);

		const tuned = readPersonCutoutLayerSettings({
			params: { ...smartLayer.params, maskThreshold: 0.6 },
		});
		expect(
			buildPersonCutoutLayerSourceSignature({
				layer: smartLayer,
				bindings,
				mediaAssets: assets,
				settings: tuned,
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
		const settings = readPersonCutoutLayerSettings({
			params: baseLayer.params,
		});
		const signature = buildPersonCutoutLayerSourceSignature({
			layer: baseLayer,
			bindings,
			mediaAssets: assets,
			settings,
		});
		const appliedLayer = layer({
			...baseLayer.params,
			matteApplied: true,
			matteCacheKey: buildPersonCutoutLayerMatteCacheKey({
				layerId: baseLayer.id,
				signature,
			}),
			sourceSignature: signature,
			appliedStartTime: baseLayer.startTime,
			appliedDuration: baseLayer.duration,
		});

		expect(
			isPersonCutoutLayerAppliedAndCurrent({
				layer: appliedLayer,
				signature,
			}),
		).toBe(true);
		expect(
			isPersonCutoutLayerAppliedAndCurrent({
				layer: { ...appliedLayer, duration: ticks(401) },
				signature,
			}),
		).toBe(false);
	});

	test("accepts a legacy signature after unrelated tracks shift every source index", () => {
		const sceneTracks = tracks();
		const baseLayer = layer();
		const originalBindings = getSpeakerFrameSourceBindings({
			tracks: sceneTracks,
			smartTrackId: "smart-track",
			layer: baseLayer,
		});
		const settings = readPersonCutoutLayerSettings({
			params: baseLayer.params,
		});
		const storedSignature = buildPersonCutoutLayerSourceSignature({
			layer: baseLayer,
			bindings: originalBindings,
			mediaAssets: assets,
			settings,
		});
		const shiftedBindings = originalBindings.map((binding) => ({
			...binding,
			trackIndex: binding.trackIndex + 3,
		}));
		const currentSignature = buildPersonCutoutLayerSourceSignature({
			layer: baseLayer,
			bindings: shiftedBindings,
			mediaAssets: assets,
			settings,
		});
		const legacySignatures = buildPersonCutoutLayerLegacySourceSignatures({
			layer: baseLayer,
			bindings: shiftedBindings,
			mediaAssets: assets,
			settings,
			maxTrackIndexShift: 4,
		});
		const appliedLayer = layer({
			...baseLayer.params,
			matteApplied: true,
			matteCacheKey: buildPersonCutoutLayerMatteCacheKey({
				layerId: baseLayer.id,
				signature: storedSignature,
			}),
			sourceSignature: storedSignature,
			appliedStartTime: baseLayer.startTime,
			appliedDuration: baseLayer.duration,
		});

		expect(legacySignatures).toContain(storedSignature);
		expect(
			isPersonCutoutLayerAppliedAndCurrent({
				layer: appliedLayer,
				signature: currentSignature,
				legacySignatures,
			}),
		).toBe(true);
	});

	test("builds a stable, layer-scoped matte cache key", () => {
		expect(
			buildPersonCutoutLayerMatteCacheKey({
				layerId: "cutout",
				signature: "pcl-v1-abc123",
			}),
		).toBe("person-cutout-layer:cutout:pcl-v1-abc123");
	});
});
