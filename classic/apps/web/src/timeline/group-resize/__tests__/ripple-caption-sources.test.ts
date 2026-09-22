import { expect, test } from "bun:test";
import "./mock-ripple-wasm";
import { rippleCaptionSources } from "../ripple-caption-sources";
import type { SceneTracks } from "@/timeline/types";
import { mediaTimeFromSeconds } from "@/wasm";

test("a splice shifts all source words once without matching moved neighbors", () => {
	const words = Array.from({ length: 20 }, (_, i) => ({
		text: `word-${i}!`,
		start: i,
		end: i + 0.25,
	}));
	const tracks = {
		main: { id: "main", type: "video", elements: [] },
		audio: [],
		overlay: [
			{
				id: "text",
				type: "text",
				elements: [],
				captionSource: { sourceId: "source", words },
			},
		],
	} as unknown as SceneTracks;
	const result = rippleCaptionSources({
		tracks,
		cutTime: mediaTimeFromSeconds({ seconds: 5.75 }),
		insertedDuration: mediaTimeFromSeconds({ seconds: -0.5 }),
	});
	const next = result.overlay[0];
	expect(next.type).toBe("text");
	if (next.type !== "text") throw Error("expected text");
	expect(next.captionSource?.words).toHaveLength(20);
	expect(next.captionSource?.words[6]).toEqual({
		text: "word-6!",
		start: 5.5,
		end: 5.75,
	});
	expect(next.captionSource?.words[19]).toEqual({
		text: "word-19!",
		start: 18.5,
		end: 18.75,
	});
	expect(words[6].start).toBe(6);
});
