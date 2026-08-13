import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { BackgroundRemovalSettings } from "@/background-removal";
import {
	getDisplayTracks,
	type SceneTracks,
	type VideoElement,
	type VideoTrack,
} from "@/timeline";
import type { MediaTime } from "@/wasm";

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
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	defaultBackgroundRemovalSettings: () => defaultSettings,
	resolveBackgroundRemovalSettings: (settings: BackgroundRemovalSettings) => ({
		...settings,
		inputSize: 384,
		previewFps: 24,
		cacheEntries: 48,
		blurSigma: 2 + settings.blurStrength * 38,
	}),
	planBackgroundRemovalDuplicate: () => ({
		kind: "newTrack",
		insertIndex: 0,
	}),
}));

let buildSpeakerTileEdit: typeof import("@/timeline/speaker-tile").buildSpeakerTileEdit;
let buildSpeakerFrameBreakoutEdit: typeof import("@/timeline/speaker-tile").buildSpeakerFrameBreakoutEdit;

beforeAll(async () => {
	({ buildSpeakerTileEdit, buildSpeakerFrameBreakoutEdit } =
		await import("@/timeline/speaker-tile"));
});

function videoElement(): VideoElement {
	return {
		id: "speaker",
		type: "video",
		name: "Speaker",
		mediaId: "media-1",
		startTime: 100 as MediaTime,
		duration: 500 as MediaTime,
		trimStart: 0 as MediaTime,
		trimEnd: 0 as MediaTime,
		params: {},
		isSourceAudioEnabled: true,
	};
}

function videoTrack(element: VideoElement): VideoTrack {
	return {
		id: "main",
		name: "Main",
		type: "video",
		elements: [element],
		muted: false,
		hidden: false,
	};
}

function buildTracks(): SceneTracks {
	return {
		overlay: [],
		main: videoTrack(videoElement()),
		audio: [],
		order: ["main"],
	};
}

describe("speaker tile edit", () => {
	test("duplicates the speaker into a silent rounded tile on the camera canvas", () => {
		const result = buildSpeakerTileEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 640,
				positionY: -180,
				scaleX: 0.4,
				scaleY: 0.4,
				cameraDepth: 1.25,
				presentation: "rounded-rectangle",
				removeBackground: false,
				cornerRadius: 0.16,
				borderColor: "#ffffff",
				borderWidth: 6,
			},
		});
		const duplicate = result?.tracks.overlay[0]?.elements[0];

		expect(duplicate?.type).toBe("video");
		if (duplicate?.type !== "video") return;
		expect(duplicate.isSourceAudioEnabled).toBe(false);
		expect(duplicate.params).toMatchObject({
			"transform.positionX": 640,
			"transform.positionY": -180,
			"transform.scaleX": 0.4,
			"transform.scaleY": 0.4,
			"camera.depth": 1.25,
		});
		expect(duplicate.backgroundRemoval?.enabled).toBe(false);
		expect(duplicate.masks?.[0]).toMatchObject({
			type: "rounded-rectangle",
			params: {
				width: 1,
				height: 1,
				cornerRadius: 0.16,
				strokeWidth: 6,
			},
		});
	});

	test("creates a background-removed cutout when requested", () => {
		const result = buildSpeakerTileEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 0,
				positionY: 0,
				scaleX: 0.5,
				scaleY: 0.5,
				cameraDepth: 1,
				presentation: "cutout",
				removeBackground: true,
				cornerRadius: 0.12,
				borderColor: "#ffffff",
				borderWidth: 0,
			},
		});
		const duplicate = result?.tracks.overlay[0]?.elements[0];

		expect(duplicate?.type).toBe("video");
		if (duplicate?.type !== "video") return;
		expect(duplicate.backgroundRemoval?.enabled).toBe(true);
		expect(duplicate.masks).toEqual([]);
	});

	test("limits a speaker tile to an exact visual interval and preserves source sync", () => {
		const result = buildSpeakerTileEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 0,
				positionY: 0,
				scaleX: 0.5,
				scaleY: 0.5,
				cameraDepth: 1,
				presentation: "cutout",
				removeBackground: true,
				cornerRadius: 0.12,
				borderColor: "#ffffff",
				borderWidth: 0,
				startTime: 200 as MediaTime,
				duration: 160 as MediaTime,
			},
		});
		const duplicate = result?.tracks.overlay[0]?.elements[0];

		expect(duplicate).toMatchObject({
			startTime: 200,
			duration: 160,
			trimStart: 100,
			trimEnd: 240,
			isSourceAudioEnabled: false,
		});
	});

	test("rejects a speaker visual interval outside the source element", () => {
		const result = buildSpeakerTileEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 0,
				positionY: 0,
				scaleX: 0.5,
				scaleY: 0.5,
				cameraDepth: 1,
				presentation: "cutout",
				removeBackground: true,
				cornerRadius: 0.12,
				borderColor: "#ffffff",
				borderWidth: 0,
				startTime: 550 as MediaTime,
				duration: 100 as MediaTime,
			},
		});

		expect(result).toBeNull();
	});

	test("builds an atomic paper-grid frame breakout with one audible source", () => {
		const result = buildSpeakerFrameBreakoutEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 0,
				positionY: 410,
				scaleX: 0.7,
				scaleY: 0.7,
				cameraDepth: 1,
				cropTop: 0.22,
				cornerRadius: 0.08,
				borderColor: "#ffffff",
				borderWidth: 0,
				backgroundPresetId: "paper-grid",
				backgroundScaleX: 1.12,
				backgroundScaleY: 3.35,
				backgroundCameraDepth: 0.35,
				backgroundCameraLocked: false,
			},
		});
		expect(result).not.toBeNull();
		if (!result) return;

		const displayTracks = getDisplayTracks({ tracks: result.tracks });
		expect(displayTracks.map((track) => track.id)).toEqual([
			result.foreground.trackId,
			result.base.trackId,
			result.background.trackId,
			"main",
		]);
		expect(displayTracks.map((track) => track.type)).toEqual([
			"video",
			"video",
			"graphic",
			"video",
		]);

		const foreground = displayTracks[0]?.elements[0];
		const base = displayTracks[1]?.elements[0];
		const background = displayTracks[2]?.elements[0];
		const source = displayTracks[3]?.elements[0];
		expect(foreground?.type).toBe("video");
		expect(base?.type).toBe("video");
		expect(background?.type).toBe("graphic");
		expect(source?.type).toBe("video");
		if (
			foreground?.type !== "video" ||
			base?.type !== "video" ||
			background?.type !== "graphic" ||
			source?.type !== "video"
		) {
			return;
		}

		expect(foreground.isSourceAudioEnabled).toBe(false);
		expect(base.isSourceAudioEnabled).toBe(false);
		expect(source.isSourceAudioEnabled).toBe(true);
		expect(foreground.backgroundRemoval?.enabled).toBe(true);
		expect(base.backgroundRemoval?.enabled).toBe(false);
		expect(base.masks?.[0]).toMatchObject({
			type: "rounded-rectangle",
			params: {
				height: 0.78,
				centerY: 0.11,
				cornerRadius: 0.08,
			},
		});
		expect(background.definitionId).toBe("preset-background");
		expect(background.params).toMatchObject({
			preset: "grid",
			presetId: "paper-grid",
			"transform.scaleX": 1.12,
			"transform.scaleY": 3.35,
			"camera.depth": 0.35,
			"camera.locked": false,
		});
		for (const visual of [foreground, base, background]) {
			expect(visual.startTime).toBe(source.startTime);
			expect(visual.duration).toBe(source.duration);
		}
		expect(foreground.mediaId).toBe(source.mediaId);
		expect(base.mediaId).toBe(source.mediaId);
		expect(foreground.trimStart).toBe(source.trimStart);
		expect(base.trimStart).toBe(source.trimStart);
	});

	test("limits every frame-breakout visual to the same exact interval", () => {
		const result = buildSpeakerFrameBreakoutEdit({
			tracks: buildTracks(),
			trackId: "main",
			elementId: "speaker",
			options: {
				positionX: 0,
				positionY: 410,
				scaleX: 0.7,
				scaleY: 0.7,
				cameraDepth: 1,
				cropTop: 0.22,
				cornerRadius: 0.08,
				borderColor: "#ffffff",
				borderWidth: 0,
				backgroundPresetId: "paper-grid",
				startTime: 200 as MediaTime,
				duration: 160 as MediaTime,
			},
		});
		expect(result).not.toBeNull();
		if (!result) return;

		const displayTracks = getDisplayTracks({ tracks: result.tracks });
		const foreground = displayTracks[0]?.elements[0];
		const base = displayTracks[1]?.elements[0];
		const background = displayTracks[2]?.elements[0];
		const source = displayTracks[3]?.elements[0];
		for (const visual of [foreground, base, background]) {
			expect(visual).toMatchObject({ startTime: 200, duration: 160 });
		}
		expect(foreground).toMatchObject({ trimStart: 100, trimEnd: 240 });
		expect(base).toMatchObject({ trimStart: 100, trimEnd: 240 });
		expect(source).toMatchObject({
			startTime: 100,
			duration: 500,
			trimStart: 0,
			trimEnd: 0,
			isSourceAudioEnabled: true,
		});
	});
});
