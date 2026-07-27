import {
	defaultBackgroundRemovalSettings as defaultSettingsFromRust,
	planBackgroundRemovalDuplicate as planDuplicateFromRust,
	resolveBackgroundRemovalSettings as resolveSettingsFromRust,
} from "opencut-wasm";
import type { TimelineTrack } from "@/timeline";
import type {
	BackgroundRemovalDuplicatePlacement,
	BackgroundRemovalSettings,
	ResolvedBackgroundRemovalSettings,
} from "./types";

export function getDefaultBackgroundRemovalSettings(): BackgroundRemovalSettings {
	const value: unknown = defaultSettingsFromRust();
	if (!isBackgroundRemovalSettings(value)) {
		throw new Error("Rust returned invalid background removal defaults");
	}
	return value;
}

export function resolveBackgroundRemovalSettings({
	settings,
}: {
	settings: BackgroundRemovalSettings;
}): ResolvedBackgroundRemovalSettings {
	const value: unknown = resolveSettingsFromRust(settings);
	if (!isResolvedBackgroundRemovalSettings(value)) {
		throw new Error("Rust returned invalid background removal settings");
	}
	return value;
}

export function planBackgroundRemovalDuplicate({
	tracks,
	sourceTrackIndex,
	sourceStartTime,
	sourceDuration,
}: {
	tracks: TimelineTrack[];
	sourceTrackIndex: number;
	sourceStartTime: number;
	sourceDuration: number;
}): BackgroundRemovalDuplicatePlacement {
	const value: unknown = planDuplicateFromRust({
		sourceTrackIndex,
		sourceStartTime,
		sourceDuration,
		tracks: tracks.map((track) => ({
			id: track.id,
			trackType: track.type,
			spans: track.elements.map((element) => ({
				startTime: element.startTime,
				duration: element.duration,
			})),
		})),
	});
	if (!isBackgroundRemovalDuplicatePlacement(value)) {
		throw new Error("Rust returned an invalid background removal placement");
	}
	return value;
}

function isBackgroundRemovalSettings(
	value: unknown,
): value is BackgroundRemovalSettings {
	return (
		isRecord(value) &&
		typeof value.enabled === "boolean" &&
		(value.mode === "remove" ||
			value.mode === "blur" ||
			value.mode === "grayscale") &&
		(value.quality === "fast" ||
			value.quality === "balanced" ||
			value.quality === "precise") &&
		isFiniteNumber(value.maskThreshold) &&
		isFiniteNumber(value.edgeContrast) &&
		isFiniteNumber(value.edgeFeather) &&
		isFiniteNumber(value.temporalSmoothing) &&
		isFiniteNumber(value.blurStrength)
	);
}

function isResolvedBackgroundRemovalSettings(
	value: unknown,
): value is ResolvedBackgroundRemovalSettings {
	if (!isRecord(value) || !isBackgroundRemovalSettings(value)) return false;
	return (
		isFiniteNumber(value.inputSize) &&
		isFiniteNumber(value.previewFps) &&
		isFiniteNumber(value.cacheEntries) &&
		isFiniteNumber(value.blurSigma)
	);
}

function isBackgroundRemovalDuplicatePlacement(
	value: unknown,
): value is BackgroundRemovalDuplicatePlacement {
	if (!isRecord(value)) return false;
	if (value.kind === "existingTrack") {
		return typeof value.trackId === "string";
	}
	return (
		value.kind === "newTrack" &&
		isFiniteNumber(value.insertIndex) &&
		Number.isInteger(value.insertIndex) &&
		value.insertIndex >= 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
