import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { BackgroundRemovalSettings } from "@/background-removal";
import {
	getDisplayTracks,
	type SceneTracks,
	type TextTrack,
	type VideoElement,
	type VideoTrack,
} from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const defaultSettings: BackgroundRemovalSettings = {
	enabled: true,
	mode: "remove",
	quality: "balanced",
	maskThreshold: 0.5,
	edgeContrast: 1,
	edgeFeather: 0.5,
	temporalSmoothing: 0.24,
	blurStrength: 0.55,
};

mock.module("opencut-wasm", () => ({
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({
		clips: options.clips,
		timelineDuration: 0,
	}),
	defaultBackgroundRemovalSettings: () => defaultSettings,
	resolveBackgroundRemovalSettings: (settings: BackgroundRemovalSettings) => ({
		...settings,
		inputSize: 384,
		previewFps: 24,
		cacheEntries: 48,
		blurSigma: 2 + settings.blurStrength * 38,
	}),
	planBackgroundRemovalDuplicate: ({
		sourceTrackIndex,
		sourceStartTime,
		sourceDuration,
		tracks,
	}: {
		sourceTrackIndex: number;
		sourceStartTime: number;
		sourceDuration: number;
		tracks: Array<{
			id: string;
			trackType: string;
			spans: Array<{ startTime: number; duration: number }>;
		}>;
	}) => {
		const above = tracks[sourceTrackIndex - 1];
		const sourceEnd = sourceStartTime + sourceDuration;
		const overlaps = above?.spans.some(
			(span) =>
				sourceStartTime < span.startTime + span.duration &&
				sourceEnd > span.startTime,
		);
		return above?.trackType === "video" && !overlaps
			? { kind: "existingTrack", trackId: above.id }
			: { kind: "newTrack", insertIndex: sourceTrackIndex };
	},
}));

let backgroundRemoval: typeof import("@/background-removal");

beforeAll(async () => {
	backgroundRemoval = await import("@/background-removal");
});

function videoElement({
	id,
	startTime = 100,
	duration = 50,
}: {
	id: string;
	startTime?: number;
	duration?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "media-1",
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		isSourceAudioEnabled: true,
	};
}

function videoTrack({
	id,
	elements,
}: {
	id: string;
	elements: VideoElement[];
}): VideoTrack {
	return { id, name: id, type: "video", elements, muted: false, hidden: false };
}

function textTrack(id: string): TextTrack {
	return { id, name: id, type: "text", elements: [], hidden: false };
}

function tracksWithAbove(above: SceneTracks["overlay"][number]): SceneTracks {
	return {
		overlay: [above],
		main: videoTrack({
			id: "source",
			elements: [videoElement({ id: "clip" })],
		}),
		audio: [],
		order: [above.id, "source"],
	};
}

describe("background removal duplicate placement", () => {
	test("reuses an immediately-above free video track and disables duplicate audio", () => {
		const settings = backgroundRemoval.getDefaultBackgroundRemovalSettings();
		const before = tracksWithAbove(
			videoTrack({
				id: "above",
				elements: [
					videoElement({ id: "earlier", startTime: 0, duration: 100 }),
				],
			}),
		);
		const result = backgroundRemoval.buildBackgroundRemovalEdit({
			tracks: before,
			trackId: "source",
			elementId: "clip",
			settings,
			duplicate: true,
			duplicateElementId: "duplicate",
			duplicateTrackId: "unused-track",
		});

		expect(result?.createdTrack).toBe(false);
		expect(result?.target).toEqual({
			trackId: "above",
			elementId: "duplicate",
		});
		const duplicate = result?.tracks.overlay[0]?.elements.find(
			(element) => element.id === "duplicate",
		);
		expect(duplicate?.type).toBe("video");
		if (duplicate?.type === "video") {
			expect(duplicate.isSourceAudioEnabled).toBe(false);
			expect(duplicate.backgroundRemoval?.enabled).toBe(true);
		}
		const original = before.main.elements[0];
		expect(original?.type).toBe("video");
		if (original?.type === "video") {
			expect(original.backgroundRemoval).toBeUndefined();
		}
	});

	test("inserts a new video track when the track above is not video", () => {
		const settings = backgroundRemoval.getDefaultBackgroundRemovalSettings();
		const before = tracksWithAbove(textTrack("titles"));
		const result = backgroundRemoval.buildBackgroundRemovalEdit({
			tracks: before,
			trackId: "source",
			elementId: "clip",
			settings,
			duplicate: true,
			duplicateElementId: "duplicate",
			duplicateTrackId: "person-track",
		});

		expect(result?.createdTrack).toBe(true);
		expect(result?.target).toEqual({
			trackId: "person-track",
			elementId: "duplicate",
		});
		expect(
			getDisplayTracks({ tracks: result!.tracks }).map((track) => track.type),
		).toEqual(["text", "video", "video"]);
		expect(result?.tracks.overlay[0]?.id).toBe("titles");
	});

	test("does not overwrite an occupied video track above", () => {
		const settings = backgroundRemoval.getDefaultBackgroundRemovalSettings();
		const occupied = videoTrack({
			id: "occupied",
			elements: [videoElement({ id: "other", startTime: 120, duration: 20 })],
		});
		const before = tracksWithAbove(occupied);
		const result = backgroundRemoval.buildBackgroundRemovalEdit({
			tracks: before,
			trackId: "source",
			elementId: "clip",
			settings,
			duplicate: true,
			duplicateElementId: "duplicate",
			duplicateTrackId: "safe-track",
		});

		expect(result?.createdTrack).toBe(true);
		expect(
			result?.tracks.overlay.find((track) => track.id === "occupied")?.elements,
		).toHaveLength(1);
		expect(
			getDisplayTracks({ tracks: result!.tracks }).map((track) => track.id),
		).toEqual(["occupied", "safe-track", "source"]);
	});

	test("updates the source clip without adding a track when duplication is off", () => {
		const settings = backgroundRemoval.getDefaultBackgroundRemovalSettings();
		const before = tracksWithAbove(textTrack("titles"));
		const result = backgroundRemoval.buildBackgroundRemovalEdit({
			tracks: before,
			trackId: "source",
			elementId: "clip",
			settings: { ...settings, mode: "grayscale" },
			duplicate: false,
		});

		expect(result?.createdTrack).toBe(false);
		expect(getDisplayTracks({ tracks: result!.tracks })).toHaveLength(2);
		const updated = result?.tracks.main.elements[0];
		expect(updated?.type).toBe("video");
		if (updated?.type === "video") {
			expect(updated.backgroundRemoval?.mode).toBe("grayscale");
		}
	});
});
