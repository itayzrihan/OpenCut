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
	test("retains explicitly created empty video and audio tracks across later edits", () => {
		const tracks = buildTracks();
		tracks.overlay[1].keepEmpty = true;
		tracks.audio[0].keepEmpty = true;
		const pruned = pruneEmptyElementTracks({ tracks });
		expect(pruned.overlay.map((track) => track.id)).toEqual(["parallax-1", "empty-video"]);
		expect(pruned.audio.map((track) => track.id)).toEqual(["empty-audio"]);
	});
	test("keeps an empty parallax marker while pruning empty element tracks", () => {
		const pruned = pruneEmptyElementTracks({ tracks: buildTracks() });

		expect(pruned.overlay.map((track) => track.id)).toEqual(["parallax-1"]);
		expect(pruned.audio).toEqual([]);
	});
});
