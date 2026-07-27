import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	EffectTrack,
	SceneTracks,
	TextTrack,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import {
	getDisplayTracks,
	splitTrackByType,
	withReorderedTrack,
} from "@/timeline";

function track({
	id,
	type,
}: {
	id: string;
	type: TimelineTrack["type"];
}): TimelineTrack {
	const base = { id, type, name: id, elements: [] };
	if (type === "audio") {
		return { ...base, type, muted: false };
	}
	if (type === "video") {
		return { ...base, type, muted: false, hidden: false };
	}
	return { ...base, type, hidden: false } as TimelineTrack;
}

function tracks(): SceneTracks {
	return {
		overlay: [
			track({ id: "text-1", type: "text" }) as TextTrack,
			track({ id: "effect-1", type: "effect" }) as EffectTrack,
		],
		main: track({ id: "main", type: "video" }) as VideoTrack,
		audio: [track({ id: "audio-1", type: "audio" }) as AudioTrack],
		order: ["text-1", "main", "audio-1", "effect-1"],
	};
}

describe("track order", () => {
	test("uses explicit display order across track buckets", () => {
		expect(getDisplayTracks({ tracks: tracks() }).map((item) => item.id)).toEqual([
			"text-1",
			"main",
			"audio-1",
			"effect-1",
		]);
	});

	test("reorders any track type", () => {
		const reordered = withReorderedTrack({
			tracks: tracks(),
			trackId: "audio-1",
			toIndex: 0,
		});
		expect(getDisplayTracks({ tracks: reordered }).map((item) => item.id)).toEqual([
			"audio-1",
			"text-1",
			"main",
			"effect-1",
		]);
	});

	test("inserts new tracks at display index while keeping typed buckets", () => {
		const inserted = splitTrackByType({
			tracks: tracks(),
			track: track({ id: "video-2", type: "video" }),
			insertIndex: 2,
		});
		expect(getDisplayTracks({ tracks: inserted }).map((item) => item.id)).toEqual([
			"text-1",
			"main",
			"video-2",
			"audio-1",
			"effect-1",
		]);
		expect(inserted.overlay.map((item) => item.id)).toContain("video-2");
	});
});
