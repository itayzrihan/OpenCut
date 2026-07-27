import { describe, expect, test } from "bun:test";
import type { ImageElement, SceneTracks, VideoTrack } from "@/timeline";
import { buildMoveGroup, resolveGroupMove } from "@/timeline/group-move";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function t(ticks: number) {
	return mediaTime({ ticks });
}

function buildImageElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): ImageElement {
	return {
		id,
		type: "image",
		name: id,
		startTime: t(startTime),
		duration: t(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function buildVideoTrack({
	elements,
}: {
	elements: VideoTrack["elements"];
}): VideoTrack {
	return {
		id: "main",
		type: "video",
		name: "Main",
		elements,
		muted: false,
		hidden: false,
	};
}

function buildSceneTracks(main: VideoTrack): SceneTracks {
	return {
		overlay: [],
		main,
		audio: [],
	};
}

describe("resolveGroupMove", () => {
	test("keeps the requested start time when moving the only main-track image forward", () => {
		const element = buildImageElement({
			id: "image-1",
			startTime: 0,
			duration: 100,
		});
		const tracks = buildSceneTracks(buildVideoTrack({ elements: [element] }));
		const group = buildMoveGroup({
			anchorRef: { trackId: tracks.main.id, elementId: element.id },
			selectedElements: [{ trackId: tracks.main.id, elementId: element.id }],
			tracks,
		});

		expect(group).not.toBeNull();

		const result =
			group &&
			resolveGroupMove({
				group,
				tracks,
				anchorStartTime: t(40),
				target: {
					kind: "existingTrack",
					anchorTargetTrackId: tracks.main.id,
				},
			});

		expect(result?.moves).toEqual([
			{
				sourceTrackId: tracks.main.id,
				targetTrackId: tracks.main.id,
				elementId: element.id,
				newStartTime: t(40),
			},
		]);
	});
});
