import { describe, expect, test } from "bun:test";
import type { TextElement, TextTrack } from "@/timeline";
import {
	getTrackIndexByElementId,
	getTrackIndexesForElementIds,
} from "@/timeline/components/track-element-index";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm/media-time";

function textElement({ id }: { id: string }): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: TICKS_PER_SECOND }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function textTrack({
	id,
	elements,
}: {
	id: string;
	elements: TextElement[];
}): TextTrack {
	return {
		id,
		name: id,
		type: "text",
		hidden: false,
		elements,
	};
}

describe("track element index", () => {
	test("maps element ids to their display track indexes", () => {
		const trackIndexByElementId = getTrackIndexByElementId({
			tracks: [
				textTrack({
					id: "track-a",
					elements: [textElement({ id: "a-1" })],
				}),
				textTrack({
					id: "track-b",
					elements: [textElement({ id: "b-1" }), textElement({ id: "b-2" })],
				}),
			],
		});

		expect(trackIndexByElementId.get("a-1")).toBe(0);
		expect(trackIndexByElementId.get("b-1")).toBe(1);
		expect(trackIndexByElementId.get("b-2")).toBe(1);
	});

	test("dedupes dragged element ids into affected track indexes", () => {
		const trackIndexByElementId = new Map([
			["a-1", 0],
			["b-1", 1],
			["b-2", 1],
		]);

		expect(
			[
				...getTrackIndexesForElementIds({
					elementIds: ["missing", "b-1", "b-2", "a-1"],
					trackIndexByElementId,
				}),
			],
		).toEqual([1, 0]);
	});
});
