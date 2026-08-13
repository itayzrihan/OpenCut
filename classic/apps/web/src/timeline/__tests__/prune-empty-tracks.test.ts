import { describe, expect, test } from "bun:test";
import { pruneEmptyElementTracks } from "@/timeline/prune-empty-tracks";
import type { SceneTracks } from "@/timeline/types";

function buildTracks(): SceneTracks {
	return {
		overlay: [
			{
				id: "parallax-1",
				name: "Parallax group",
				type: "parallax",
				elements: [],
				direction: "against-camera",
				speedPercent: 35,
			},
			{
				id: "empty-video",
				name: "Empty video",
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
		],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		audio: [
			{
				id: "empty-audio",
				name: "Empty audio",
				type: "audio",
				elements: [],
				muted: false,
			},
		],
		order: ["parallax-1", "empty-video", "main", "empty-audio"],
	};
}

describe("pruneEmptyElementTracks", () => {
	test("keeps an empty parallax marker while pruning empty element tracks", () => {
		const pruned = pruneEmptyElementTracks({ tracks: buildTracks() });

		expect(pruned.overlay.map((track) => track.id)).toEqual(["parallax-1"]);
		expect(pruned.audio).toEqual([]);
	});
});
