import { expect, test } from "bun:test";
import { MEDIA_RANGE_BYTES, mediaRangeEnd } from "../media-range";

test("a 20 GB camera file is read in bounded, contiguous HTTP ranges", () => {
	const size = 20 * 1024 ** 3;
	let start = 0;
	for (let index = 0; index < 5; index++) {
		const end = mediaRangeEnd({ start, requestedEnd: "", size });
		expect(end - start + 1).toBe(MEDIA_RANGE_BYTES);
		start = end + 1;
	}
	expect(start).toBe(5 * MEDIA_RANGE_BYTES);
});

test("preserves explicit ranges and ends precisely at the final byte", () => {
	expect(mediaRangeEnd({ start: 100, requestedEnd: "199", size: 1000 })).toBe(
		199,
	);
	expect(mediaRangeEnd({ start: 990, requestedEnd: "", size: 1000 })).toBe(999);
	expect(mediaRangeEnd({ start: 990, requestedEnd: "2000", size: 1000 })).toBe(
		999,
	);
	expect(mediaRangeEnd({ start: 0, requestedEnd: "0", size: 1000 })).toBe(0);
});
