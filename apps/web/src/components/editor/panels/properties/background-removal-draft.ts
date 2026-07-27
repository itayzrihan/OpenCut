import type { BackgroundRemovalSettings } from "@/background-removal/types";

export function createBackgroundRemovalDraft({
	persistedSettings,
	defaultSettings,
}: {
	persistedSettings: BackgroundRemovalSettings | undefined;
	defaultSettings: BackgroundRemovalSettings;
}): BackgroundRemovalSettings {
	return persistedSettings
		? { ...persistedSettings }
		: { ...defaultSettings, enabled: false };
}

export function areBackgroundRemovalSettingsEqual({
	left,
	right,
}: {
	left: BackgroundRemovalSettings;
	right: BackgroundRemovalSettings;
}): boolean {
	return (
		left.enabled === right.enabled &&
		left.mode === right.mode &&
		left.quality === right.quality &&
		left.maskThreshold === right.maskThreshold &&
		left.edgeContrast === right.edgeContrast &&
		left.edgeFeather === right.edgeFeather &&
		left.temporalSmoothing === right.temporalSmoothing &&
		left.blurStrength === right.blurStrength
	);
}

export function didPersistedBackgroundRemovalChange({
	previous,
	next,
}: {
	previous: BackgroundRemovalSettings | undefined;
	next: BackgroundRemovalSettings | undefined;
}): boolean {
	if (!previous || !next) return previous !== next;
	return !areBackgroundRemovalSettingsEqual({ left: previous, right: next });
}

export function shouldResetBackgroundRemovalDraft({
	previousElementId,
	nextElementId,
	previousSettings,
	nextSettings,
}: {
	previousElementId: string;
	nextElementId: string;
	previousSettings: BackgroundRemovalSettings | undefined;
	nextSettings: BackgroundRemovalSettings | undefined;
}): boolean {
	return (
		previousElementId !== nextElementId ||
		didPersistedBackgroundRemovalChange({
			previous: previousSettings,
			next: nextSettings,
		})
	);
}
