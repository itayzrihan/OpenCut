import { describe, expect, test } from "bun:test";
import type { BackgroundRemovalSettings } from "@/background-removal/types";
import {
	areBackgroundRemovalSettingsEqual,
	createBackgroundRemovalDraft,
	shouldResetBackgroundRemovalDraft,
} from "../background-removal-draft";

const defaults: BackgroundRemovalSettings = {
	enabled: true,
	mode: "remove",
	quality: "balanced",
	maskThreshold: 0.5,
	edgeContrast: 1,
	edgeFeather: 0.5,
	temporalSmoothing: 0.24,
	blurStrength: 0.55,
};

describe("background removal draft state", () => {
	test("starts a new element disabled without mutating Rust defaults", () => {
		const draft = createBackgroundRemovalDraft({
			persistedSettings: undefined,
			defaultSettings: defaults,
		});

		expect(draft).toEqual({ ...defaults, enabled: false });
		expect(draft).not.toBe(defaults);
		expect(defaults.enabled).toBe(true);
	});

	test("copies persisted settings so tuning remains staged until Apply", () => {
		const persisted = { ...defaults, mode: "blur" as const, blurStrength: 0.8 };
		const draft = createBackgroundRemovalDraft({
			persistedSettings: persisted,
			defaultSettings: defaults,
		});

		draft.blurStrength = 0.9;

		expect(persisted.blurStrength).toBe(0.8);
		expect(
			areBackgroundRemovalSettingsEqual({ left: persisted, right: draft }),
		).toBe(false);
	});

	test("compares every setting used to enable Apply", () => {
		const fields: Array<keyof BackgroundRemovalSettings> = [
			"enabled",
			"mode",
			"quality",
			"maskThreshold",
			"edgeContrast",
			"edgeFeather",
			"temporalSmoothing",
			"blurStrength",
		];

		for (const field of fields) {
			const changed = { ...defaults };
			switch (field) {
				case "enabled":
					changed.enabled = false;
					break;
				case "mode":
					changed.mode = "blur";
					break;
				case "quality":
					changed.quality = "precise";
					break;
				default:
					changed[field] += 0.1;
			}

			expect(
				areBackgroundRemovalSettingsEqual({ left: defaults, right: changed }),
			).toBe(false);
		}
	});

	test("does not reset a draft for an equivalent rerender", () => {
		expect(
			shouldResetBackgroundRemovalDraft({
				previousElementId: "video-1",
				nextElementId: "video-1",
				previousSettings: defaults,
				nextSettings: { ...defaults },
			}),
		).toBe(false);
	});

	test("resets an open draft for persisted edits and selection changes", () => {
		expect(
			shouldResetBackgroundRemovalDraft({
				previousElementId: "video-1",
				nextElementId: "video-1",
				previousSettings: defaults,
				nextSettings: { ...defaults, mode: "grayscale" },
			}),
		).toBe(true);
		expect(
			shouldResetBackgroundRemovalDraft({
				previousElementId: "video-1",
				nextElementId: "video-2",
				previousSettings: undefined,
				nextSettings: undefined,
			}),
		).toBe(true);
	});
});
