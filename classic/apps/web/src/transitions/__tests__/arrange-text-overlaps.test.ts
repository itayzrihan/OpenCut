import { describe, expect, test } from "bun:test";
import type { TextElement } from "@/timeline";
import {
	arrangeOverlappingTextTransitions,
	getOverlappingTextTransitionEntries,
} from "@/transitions";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

function textElement({
	id,
	startTime,
	duration,
	transitions,
}: {
	id: string;
	startTime: number;
	duration: number;
	transitions?: TextElement["transitions"];
}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: mediaTimeFromSeconds({ seconds: startTime }),
		duration: mediaTimeFromSeconds({ seconds: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: id },
		transitions,
	};
}

function fadeTransitions(): TextElement["transitions"] {
	return {
		in: {
			id: "in",
			presetId: "fade",
			placement: "in",
			duration: mediaTimeFromSeconds({ seconds: 1 }),
			startTime: ZERO_MEDIA_TIME,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		out: {
			id: "out",
			presetId: "fade",
			placement: "out",
			duration: mediaTimeFromSeconds({ seconds: 1 }),
			startTime: mediaTimeFromSeconds({ seconds: 4 }),
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

describe("text transition overlap arrangement", () => {
	test("treats a fractional overlap as an overlap but not touching edges", () => {
		const entries = [
			{
				trackId: "text-1",
				element: textElement({ id: "a", startTime: 0, duration: 2 }),
			},
			{
				trackId: "text-2",
				element: textElement({ id: "b", startTime: 2, duration: 1 }),
			},
			{
				trackId: "text-3",
				element: textElement({ id: "c", startTime: 1.999, duration: 0.001 }),
			},
		];

		expect(
			getOverlappingTextTransitionEntries(entries).map(
				(entry) => entry.element.id,
			),
		).toEqual(["a", "c"]);
	});

	test("splits the correction and preserves both fade durations", () => {
		const entries = [
			{
				trackId: "text-1",
				element: textElement({
					id: "old",
					startTime: 0,
					duration: 5,
					transitions: fadeTransitions(),
				}),
			},
			{
				trackId: "text-2",
				element: textElement({
					id: "new",
					startTime: 3,
					duration: 4,
					transitions: fadeTransitions(),
				}),
			},
		];

		const [oldUpdate, newUpdate] = arrangeOverlappingTextTransitions({
			entries,
		});
		const oneSecond = mediaTimeFromSeconds({ seconds: 1 });

		expect(oldUpdate?.patch.duration).toBe(
			mediaTimeFromSeconds({ seconds: 4.5 }),
		);
		expect(newUpdate?.patch.startTime).toBe(
			mediaTimeFromSeconds({ seconds: 3.5 }),
		);
		expect(newUpdate?.patch.duration).toBe(
			mediaTimeFromSeconds({ seconds: 3.5 }),
		);
		expect(oldUpdate?.patch.transitions?.out?.duration).toBe(oneSecond);
		expect(newUpdate?.patch.transitions?.in?.duration).toBe(oneSecond);
	});
});
