import type { BackgroundRemovalSettings } from "@/background-removal";
import type { MediaAsset } from "@/media/types";
import type { ParamValues } from "@/params";
import { getDisplayTracks } from "@/timeline/track-order";
import type {
	EffectElement,
	SceneTracks,
	VideoElement,
} from "@/timeline/types";
import {
	mediaTimeToSeconds,
	roundMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import { getEffectiveRateAt } from "@/retime";

export const SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE = "speaker-frame-breakout";
export const SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS = 6;

export const SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS: ParamValues = {
	backgroundPresetId: "paper-grid",
	backgroundPreset: "grid",
	backgroundColorA: "#F8F8F5",
	backgroundColorB: "#D8DAD5",
	backgroundColorC: "#FFFFFF",
	backgroundDensity: 48,
	backgroundIntensity: 12,
	backgroundScale: 52,
	backgroundSeed: 7,
	positionX: 0,
	positionY: 410,
	scaleX: 0.7,
	scaleY: 0.7,
	cropTop: 0.22,
	cornerRadius: 0.08,
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

export type SpeakerFrameBreakoutSettings = {
	backgroundPresetId: string;
	backgroundParams: ParamValues;
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
	cropTop: number;
	cornerRadius: number;
	fadeInDuration: number;
	fadeOutDuration: number;
	matte: BackgroundRemovalSettings;
	matteApplied: boolean;
	matteCacheKey: string;
	sourceSignature: string;
	appliedStartTime: MediaTime;
	appliedDuration: MediaTime;
	appliedBackend: string;
};

export type SpeakerFrameSourceBinding = {
	trackId: string;
	trackIndex: number;
	element: VideoElement;
};

export type SpeakerFrameBreakoutFade = {
	fadeInDuration: number;
	fadeOutDuration: number;
};

export type SpeakerFrameSourceCoverageGap = {
	startTime: MediaTime;
	endTime: MediaTime;
};

export function isSpeakerFrameBreakoutElement(
	element: EffectElement,
): boolean {
	return element.effectType === SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE;
}

export function readSpeakerFrameBreakoutFade({
	element,
}: {
	element: EffectElement;
}): SpeakerFrameBreakoutFade {
	const settings = readSpeakerFrameBreakoutSettings({
		params: element.params,
	});
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

export function clampSpeakerFrameBreakoutFade({
	duration,
	fadeInDuration,
	fadeOutDuration,
}: {
	duration: MediaTime;
	fadeInDuration: number;
	fadeOutDuration: number;
}): SpeakerFrameBreakoutFade {
	const maximumEach = Math.max(
		0,
		mediaTimeToSeconds({ time: roundMediaTime({ time: duration }) }) / 2,
	);
	return {
		fadeInDuration: Math.min(maximumEach, Math.max(0, fadeInDuration)),
		fadeOutDuration: Math.min(maximumEach, Math.max(0, fadeOutDuration)),
	};
}

export function speakerFrameLayoutScale({
	layoutScale,
	sourceScale,
}: {
	layoutScale: number;
	sourceScale: number;
}): number {
	return Math.abs(layoutScale) * (sourceScale < 0 ? -1 : 1);
}

export function hasUnsupportedSpeakerFramePerspective({
	source,
}: {
	source: VideoElement;
}): boolean {
	const perspectiveX = source.params["transform.perspectiveX"];
	const perspectiveY = source.params["transform.perspectiveY"];
	return (
		(typeof perspectiveX === "number" && Math.abs(perspectiveX) > 0.000_001) ||
		(typeof perspectiveY === "number" && Math.abs(perspectiveY) > 0.000_001) ||
		source.animations?.["transform.perspectiveX"] !== undefined ||
		source.animations?.["transform.perspectiveY"] !== undefined
	);
}

export function readSpeakerFrameBreakoutSettings({
	params,
}: {
	params: ParamValues;
}): SpeakerFrameBreakoutSettings {
	const defaults = SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS;
	const numberParam = (key: string) => readNumber({ params, key, defaults });
	const stringParam = (key: string) => readString({ params, key, defaults });
	const booleanParam = (key: string) => readBoolean({ params, key, defaults });
	const quality = stringParam("matteQuality");
	return {
		backgroundPresetId: stringParam("backgroundPresetId"),
		backgroundParams: {
			presetId: stringParam("backgroundPresetId"),
			preset: stringParam("backgroundPreset"),
			colorA: stringParam("backgroundColorA"),
			colorB: stringParam("backgroundColorB"),
			colorC: stringParam("backgroundColorC"),
			density: numberParam("backgroundDensity"),
			intensity: numberParam("backgroundIntensity"),
			scale: numberParam("backgroundScale"),
			seed: numberParam("backgroundSeed"),
		},
		positionX: numberParam("positionX"),
		positionY: numberParam("positionY"),
		scaleX: numberParam("scaleX"),
		scaleY: numberParam("scaleY"),
		cropTop: clamp({
			value: numberParam("cropTop"),
			minimum: 0,
			maximum: 0.95,
		}),
		cornerRadius: clamp({
			value: numberParam("cornerRadius"),
			minimum: 0,
			maximum: 0.5,
		}),
		fadeInDuration: Math.max(
			0,
			numberParam("fadeInDuration"),
		),
		fadeOutDuration: Math.max(
			0,
			numberParam("fadeOutDuration"),
		),
		matte: {
			enabled: true,
			mode: "remove",
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
			blurStrength: 0.55,
		},
		matteApplied: booleanParam("matteApplied"),
		matteCacheKey: stringParam("matteCacheKey"),
		sourceSignature: stringParam("sourceSignature"),
		appliedStartTime: roundMediaTime({
			time: numberParam("appliedStartTime"),
		}),
		appliedDuration: roundMediaTime({
			time: numberParam("appliedDuration"),
		}),
		appliedBackend: stringParam("appliedBackend"),
	};
}

export function buildSpeakerFrameBackgroundSnapshot({
	presetId,
	params,
}: {
	presetId: string;
	params: ParamValues;
}): ParamValues {
	return {
		backgroundPresetId: presetId,
		backgroundPreset: String(params.preset ?? "clean"),
		backgroundColorA: String(params.colorA ?? "#10131f"),
		backgroundColorB: String(params.colorB ?? "#f4f1e8"),
		backgroundColorC: String(params.colorC ?? "#ffffff"),
		backgroundDensity: finiteOr({ value: params.density, fallback: 48 }),
		backgroundIntensity: finiteOr({
			value: params.intensity,
			fallback: 55,
		}),
		backgroundScale: finiteOr({ value: params.scale, fallback: 52 }),
		backgroundSeed: finiteOr({ value: params.seed, fallback: 3 }),
	};
}

export function getSpeakerFrameSourceBindings({
	tracks,
	smartTrackId,
	layer,
}: {
	tracks: SceneTracks;
	smartTrackId: string;
	layer: Pick<EffectElement, "startTime" | "duration">;
}): SpeakerFrameSourceBinding[] {
	const orderedTracks = getDisplayTracks({ tracks });
	const smartTrackIndex = orderedTracks.findIndex(
		(track) => track.id === smartTrackId,
	);
	if (smartTrackIndex < 0) return [];

	const layerEnd = layer.startTime + layer.duration;
	return orderedTracks
		.slice(smartTrackIndex + 1)
		.flatMap((track, relativeTrackIndex) => {
			if (
				track.type !== "video" ||
				track.hidden
			) {
				return [];
			}
			const trackIndex = smartTrackIndex + 1 + relativeTrackIndex;
			return track.elements.flatMap((element) => {
				if (
					element.type !== "video" ||
					element.hidden ||
					element.startTime >= layerEnd ||
					element.startTime + element.duration <= layer.startTime
				) {
					return [];
				}
				return [{ trackId: track.id, trackIndex, element }];
			});
		})
		.sort((left, right) => {
			if (left.trackIndex !== right.trackIndex) {
				return left.trackIndex - right.trackIndex;
			}
			if (left.element.startTime !== right.element.startTime) {
				return left.element.startTime - right.element.startTime;
			}
			return left.element.id.localeCompare(right.element.id);
		});
}

export function resolveSpeakerFrameSourceAtTime({
	bindings,
	time,
}: {
	bindings: SpeakerFrameSourceBinding[];
	time: MediaTime;
}): SpeakerFrameSourceBinding | null {
	for (const binding of bindings) {
		const { element } = binding;
		if (
			time >= element.startTime &&
			time < element.startTime + element.duration
		) {
			return binding;
		}
	}
	return null;
}

export function getSpeakerFrameSourceCoverageGap({
	bindings,
	layer,
}: {
	bindings: SpeakerFrameSourceBinding[];
	layer: Pick<EffectElement, "startTime" | "duration">;
}): SpeakerFrameSourceCoverageGap | null {
	const layerEnd = roundMediaTime({
		time: layer.startTime + layer.duration,
	});
	let coveredUntil = layer.startTime;
	const intervals = bindings
		.map(({ element }) => ({
			startTime: roundMediaTime({
				time: Math.max(layer.startTime, element.startTime),
			}),
			endTime: roundMediaTime({
				time: Math.min(
					layerEnd,
					element.startTime + element.duration,
				),
			}),
		}))
		.filter(({ startTime, endTime }) => endTime > startTime)
		.sort((left, right) => {
			if (left.startTime !== right.startTime) {
				return left.startTime - right.startTime;
			}
			return right.endTime - left.endTime;
		});

	for (const interval of intervals) {
		if (interval.startTime > coveredUntil) {
			return {
				startTime: coveredUntil,
				endTime: interval.startTime,
			};
		}
		coveredUntil = roundMediaTime({
			time: Math.max(coveredUntil, interval.endTime),
		});
		if (coveredUntil >= layerEnd) return null;
	}
	return coveredUntil < layerEnd
		? {
				startTime: coveredUntil,
				endTime: layerEnd,
			}
		: null;
}

/**
 * Plans enough timeline samples to cover every quantized source-time matte bin
 * used by preview or export, including retimed clips and both sides of cuts.
 */
export function buildSpeakerFrameMatteSampleTimes({
	bindings,
	layer,
	previewFps,
}: {
	bindings: SpeakerFrameSourceBinding[];
	layer: Pick<EffectElement, "startTime" | "duration">;
	previewFps: number;
}): MediaTime[] {
	if (!Number.isFinite(previewFps) || previewFps <= 0 || layer.duration <= 0) {
		return [];
	}
	const layerEnd = roundMediaTime({
		time: layer.startTime + layer.duration,
	});
	const samples = new Set<number>();
	const addSample = (time: number) => {
		const bounded = Math.min(layerEnd - 1, Math.max(layer.startTime, time));
		if (bounded >= layer.startTime && bounded < layerEnd) {
			samples.add(roundMediaTime({ time: bounded }));
		}
	};
	addSample(layer.startTime);
	addSample(layerEnd - 1);

	for (const { element } of bindings) {
		const bindingStart = Math.max(layer.startTime, element.startTime);
		const bindingEnd = Math.min(
			layerEnd,
			element.startTime + element.duration,
		);
		if (bindingEnd <= bindingStart) continue;
		addSample(bindingStart);
		addSample(bindingStart - 1);
		addSample(bindingEnd - 1);
		addSample(bindingEnd);

		const rate = getEffectiveRateAt({ retime: element.retime });
		const stepTicks = Math.max(
			1,
			Math.floor(TICKS_PER_SECOND / (previewFps * rate)),
		);
		for (
			let timelineTime = bindingStart;
			timelineTime < bindingEnd;
			timelineTime += stepTicks
		) {
			addSample(timelineTime);
		}
	}

	return [...samples]
		.sort((left, right) => left - right)
		.map((time) => roundMediaTime({ time }));
}

export function buildSpeakerFrameSourceSignature({
	layer,
	bindings,
	mediaAssets,
	settings,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: SpeakerFrameBreakoutSettings;
}): string {
	return buildSpeakerFrameSourceSignatureVersion({
		layer,
		bindings,
		mediaAssets,
		settings,
		version: 5,
		includeTransientAssetUrl: false,
		includeTrackIndex: false,
	});
}

/**
 * Computes the original v4 signature so already-applied layers can migrate
 * without regenerating mattes. New Apply operations always persist v5.
 */
export function buildSpeakerFrameLegacySourceSignature({
	layer,
	bindings,
	mediaAssets,
	settings,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: SpeakerFrameBreakoutSettings;
}): string {
	return buildSpeakerFrameSourceSignatureVersion({
		layer,
		bindings,
		mediaAssets,
		settings,
		version: 4,
		includeTransientAssetUrl: true,
		includeTrackIndex: true,
	});
}

/**
 * Produces v4 aliases for a common track-index shift. Older signatures stored
 * the absolute display index, so inserting unrelated tracks above an applied
 * layer could otherwise force a needless Reapply.
 */
export function buildSpeakerFrameLegacySourceSignatures({
	layer,
	bindings,
	mediaAssets,
	settings,
	maxTrackIndexShift = 0,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: SpeakerFrameBreakoutSettings;
	maxTrackIndexShift?: number;
}): string[] {
	const maximumShift = Math.max(0, Math.floor(maxTrackIndexShift));
	const signatures = new Set<string>();
	for (let shift = -maximumShift; shift <= maximumShift; shift += 1) {
		const shiftedBindings = bindings.map((binding) => ({
			...binding,
			trackIndex: binding.trackIndex + shift,
		}));
		if (shiftedBindings.some((binding) => binding.trackIndex < 0)) {
			continue;
		}
		signatures.add(
			buildSpeakerFrameLegacySourceSignature({
				layer,
				bindings: shiftedBindings,
				mediaAssets,
				settings,
			}),
		);
	}
	return [...signatures];
}

function buildSpeakerFrameSourceSignatureVersion({
	layer,
	bindings,
	mediaAssets,
	settings,
	version,
	includeTransientAssetUrl,
	includeTrackIndex,
}: {
	layer: Pick<EffectElement, "startTime" | "duration">;
	bindings: SpeakerFrameSourceBinding[];
	mediaAssets: MediaAsset[];
	settings: SpeakerFrameBreakoutSettings;
	version: 4 | 5;
	includeTransientAssetUrl: boolean;
	includeTrackIndex: boolean;
}): string {
	const assetsById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	const serialized = JSON.stringify({
		version,
		range: [layer.startTime, layer.duration],
		matte: {
			quality: settings.matte.quality,
			maskThreshold: settings.matte.maskThreshold,
			edgeContrast: settings.matte.edgeContrast,
			temporalSmoothing: settings.matte.temporalSmoothing,
		},
		sources: bindings.map(({ trackId, trackIndex, element }) => {
			const asset = assetsById.get(element.mediaId);
			return {
				trackId,
				...(includeTrackIndex ? { trackIndex } : {}),
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
							...(includeTransientAssetUrl ? { url: asset.url ?? "" } : {}),
						}
					: null,
			};
		}),
	});
	return `sfb-v${version}-${fnv1a(serialized)}`;
}

export function isSpeakerFrameBreakoutAppliedAndCurrent({
	layer,
	signature,
	legacySignatures = [],
}: {
	layer: EffectElement;
	signature: string;
	legacySignatures?: string[];
}): boolean {
	const settings = readSpeakerFrameBreakoutSettings({ params: layer.params });
	return (
		settings.matteApplied &&
		settings.matteCacheKey.length > 0 &&
		(settings.sourceSignature === signature ||
			legacySignatures.includes(settings.sourceSignature)) &&
		settings.appliedStartTime === layer.startTime &&
		settings.appliedDuration === layer.duration
	);
}

export function buildSpeakerFrameMatteCacheKey({
	layerId,
	signature,
}: {
	layerId: string;
	signature: string;
}): string {
	return `speaker-frame-breakout:${layerId}:${signature}`;
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
