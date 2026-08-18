import type { BackgroundRemovalMode, BackgroundRemovalSettings } from "@/background-removal";
import type { MediaAsset } from "@/media/types";
import type { ParamValues } from "@/params";
import type { EffectElement } from "@/timeline/types";
import { mediaTimeToSeconds, roundMediaTime, type MediaTime } from "@/wasm";
import {
	clampSpeakerFrameBreakoutFade,
	type SpeakerFrameSourceBinding,
} from "@/simple-advanced-layers/speaker-frame-breakout";

export const PERSON_CUTOUT_LAYER_EFFECT_TYPE = "person-cutout-layer";
export const PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS = 6;

export const PERSON_CUTOUT_LAYER_DEFAULT_PARAMS: ParamValues = {
	backgroundMode: "remove",
	backgroundBlurStrength: 0.6,
	fadeInDuration: 0.35,
	fadeOutDuration: 0.35,
	matteQuality: "precise",
	maskThreshold: 0.5,
	edgeContrast: 1,
	edgeFeather: 0.5,
	temporalSmoothing: 0.24,
	matteApplied: false,
	matteCacheKey: "",
	sourceSignature: "",
	appliedStartTime: 0,
	appliedDuration: 0,
	appliedBackend: "",
};

export type PersonCutoutLayerSettings = {
	backgroundMode: BackgroundRemovalMode;
	matte: BackgroundRemovalSettings;
	fadeInDuration: number;
	fadeOutDuration: number;
	matteApplied: boolean;
	matteCacheKey: string;
	sourceSignature: string;
	appliedStartTime: MediaTime;
	appliedDuration: MediaTime;
	appliedBackend: string;
};

export type PersonCutoutLayerFade = {
	fadeInDuration: number;
	fadeOutDuration: number;
};

export function isPersonCutoutLayerElement(element: EffectElement): boolean {
	return element.effectType === PERSON_CUTOUT_LAYER_EFFECT_TYPE;
}

export function readPersonCutoutLayerFade({
	element,
}: {
	element: EffectElement;
}): PersonCutoutLayerFade {
	const settings = readPersonCutoutLayerSettings({ params: element.params });
	return clampSpeakerFrameBreakoutFade({
		duration: element.duration,
		fadeInDuration:
			element.transitions?.in?.presetId === "fade"
				? mediaTimeToSeconds({ time: element.transitions.in.duration })
				: settings.fadeInDuration,
		fadeOutDuration:
			element.transitions?.out?.presetId === "fade"
				? mediaTimeToSeconds({ time: element.transitions.out.duration })
				: settings.fadeOutDuration,
	});
}

export function readPersonCutoutLayerSettings({
	params,
}: {
	params: ParamValues;
}): PersonCutoutLayerSettings {
	const defaults = PERSON_CUTOUT_LAYER_DEFAULT_PARAMS;
	const numberParam = (key: string) => readNumber({ params, key, defaults });
	const stringParam = (key: string) => readString({ params, key, defaults });
	const booleanParam = (key: string) => readBoolean({ params, key, defaults });
	const quality = stringParam("matteQuality");
	const mode = stringParam("backgroundMode");
	return {
		backgroundMode:
			mode === "blur" || mode === "grayscale" || mode === "remove"
				? mode
				: "remove",
		matte: {
			enabled: true,
			mode:
				mode === "blur" || mode === "grayscale" || mode === "remove"
					? mode
					: "remove",
			quality:
				quality === "fast" || quality === "balanced" || quality === "precise"
					? quality
					: "precise",
			maskThreshold: clamp({
				value: numberParam("maskThreshold"),
				minimum: 0.05,
				maximum: 0.95,
			}),
			edgeContrast: clamp({
				value: numberParam("edgeContrast"),
				minimum: 0.5,
				maximum: 2.5,
			}),
			edgeFeather: clamp({
				value: numberParam("edgeFeather"),
				minimum: 0,
				maximum: 8,
			}),
			temporalSmoothing: clamp({
				value: numberParam("temporalSmoothing"),
				minimum: 0,
				maximum: 0.85,
			}),
			blurStrength: clamp({
				value: numberParam("backgroundBlurStrength"),
				minimum: 0,
				maximum: 1,
			}),
		},
		fadeInDuration: Math.max(0, numberParam("fadeInDuration")),
		fadeOutDuration: Math.max(0, numberParam("fadeOutDuration")),
		matteApplied: booleanParam("matteApplied"),
		matteCacheKey: stringParam("matteCacheKey"),
		sourceSignature: stringParam("sourceSignature"),
		appliedStartTime: roundMediaTime({ time: numberParam("appliedStartTime") }),
		appliedDuration: roundMediaTime({ time: numberParam("appliedDuration") }),
		appliedBackend: stringParam("appliedBackend"),
	};
}

export function buildPersonCutoutLayerSourceSignature({
	layer,
	bindings,
	mediaAssets,
	settings,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: PersonCutoutLayerSettings;
}): string {
	return buildPersonCutoutLayerSourceSignatureVersion({
		layer,
		bindings,
		mediaAssets,
		settings,
		version: 1,
	});
}

/**
 * Produces aliases for a common track-index shift, matching the same
 * accommodation Speaker Frame Breakout makes for inserted unrelated tracks.
 */
export function buildPersonCutoutLayerLegacySourceSignatures({
	layer,
	bindings,
	mediaAssets,
	settings,
	maxTrackIndexShift = 0,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: PersonCutoutLayerSettings;
	maxTrackIndexShift?: number;
}): string[] {
	const maximumShift = Math.max(0, Math.floor(maxTrackIndexShift));
	const signatures = new Set<string>();
	for (let shift = -maximumShift; shift <= maximumShift; shift += 1) {
		if (shift === 0) continue;
		const shiftedBindings = bindings.map((binding) => ({
			...binding,
			trackIndex: binding.trackIndex + shift,
		}));
		if (shiftedBindings.some((binding) => binding.trackIndex < 0)) {
			continue;
		}
		signatures.add(
			buildPersonCutoutLayerSourceSignatureVersion({
				layer,
				bindings: shiftedBindings,
				mediaAssets,
				settings,
				version: 1,
			}),
		);
	}
	return [...signatures];
}

function buildPersonCutoutLayerSourceSignatureVersion({
	layer,
	bindings,
	mediaAssets,
	settings,
	version,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: PersonCutoutLayerSettings;
	version: number;
}): string {
	const assetsById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const serialized = JSON.stringify({
		version,
		range: [layer.startTime, layer.duration],
		backgroundMode: settings.backgroundMode,
		matte: {
			quality: settings.matte.quality,
			maskThreshold: settings.matte.maskThreshold,
			edgeContrast: settings.matte.edgeContrast,
			temporalSmoothing: settings.matte.temporalSmoothing,
		},
		sources: bindings.map(({ trackId, element }) => {
			const asset = assetsById.get(element.mediaId);
			return {
				trackId,
				elementId: element.id,
				mediaId: element.mediaId,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.retime ?? null,
				params: element.params,
				effects: element.effects ?? [],
				masks: element.masks ?? [],
				animations: element.animations ?? null,
				transitions: element.transitions ?? null,
				backgroundRemoval: element.backgroundRemoval ?? null,
				asset: asset
					? {
							name: asset.name,
							duration: asset.duration,
							fileName: asset.file?.name ?? asset.fileName ?? "",
							fileSize: asset.file?.size ?? asset.size ?? 0,
							fileModified:
								asset.file?.lastModified ?? asset.lastModified ?? 0,
							mimeType: asset.mimeType ?? asset.file?.type ?? "",
							storageKind: asset.storageKind ?? "",
							sourcePath: asset.sourcePath ?? "",
						}
					: null,
			};
		}),
	});
	return `pcl-v${version}-${fnv1a(serialized)}`;
}

export function isPersonCutoutLayerAppliedAndCurrent({
	layer,
	signature,
	legacySignatures = [],
}: {
	layer: EffectElement;
	signature: string;
	legacySignatures?: string[];
}): boolean {
	const settings = readPersonCutoutLayerSettings({ params: layer.params });
	return (
		settings.matteApplied &&
		settings.matteCacheKey.length > 0 &&
		(settings.sourceSignature === signature ||
			legacySignatures.includes(settings.sourceSignature)) &&
		settings.appliedStartTime === layer.startTime &&
		settings.appliedDuration === layer.duration
	);
}

export function buildPersonCutoutLayerMatteCacheKey({
	layerId,
	signature,
}: {
	layerId: string;
	signature: string;
}): string {
	return `person-cutout-layer:${layerId}:${signature}`;
}

function readNumber({
	params,
	key,
	defaults,
}: {
	params: ParamValues;
	key: string;
	defaults: ParamValues;
}): number {
	return finiteOr({
		value: params[key],
		fallback: finiteOr({ value: defaults[key], fallback: 0 }),
	});
}

function readString({
	params,
	key,
	defaults,
}: {
	params: ParamValues;
	key: string;
	defaults: ParamValues;
}): string {
	const value = params[key];
	if (typeof value === "string") return value;
	const fallback = defaults[key];
	return typeof fallback === "string" ? fallback : "";
}

function readBoolean({
	params,
	key,
	defaults,
}: {
	params: ParamValues;
	key: string;
	defaults: ParamValues;
}): boolean {
	const value = params[key];
	if (typeof value === "boolean") return value;
	return defaults[key] === true;
}

function finiteOr({
	value,
	fallback,
}: {
	value: unknown;
	fallback: number;
}): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp({
	value,
	minimum,
	maximum,
}: {
	value: number;
	minimum: number;
	maximum: number;
}): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function fnv1a(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}
