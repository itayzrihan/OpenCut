import { describe, expect, test } from "bun:test";
import {
	getMediaGridColumnCount,
	getMediaVirtualRowCount,
	getMediaVirtualRowEntries,
} from "@/components/editor/panels/assets/views/assets-virtualization";

describe("media asset virtualization", () => {
	test("computes a responsive grid column count", () => {
		expect(getMediaGridColumnCount({ width: 0 })).toBe(1);
		expect(getMediaGridColumnCount({ width: 112 })).toBe(1);
		expect(getMediaGridColumnCount({ width: 240 })).toBe(2);
		expect(getMediaGridColumnCount({ width: 496 })).toBe(4);
	});

	test("groups grid entries into virtual rows", () => {
		const entries = Array.from({ length: 5 }, (_, index) => ({
			type: "media" as const,
			item: { id: `media-${index}` },
		}));

		expect(
			getMediaVirtualRowCount({
				entryCount: entries.length,
				mode: "grid",
				columnCount: 2,
			}),
		).toBe(3);
		expect(
			getMediaVirtualRowEntries({
				entries,
				mode: "grid",
				columnCount: 2,
				rowIndex: 1,
			}).map((entry) => (entry.type === "media" ? entry.item.id : "")),
		).toEqual(["media-2", "media-3"]);
	});

	test("keeps compact mode to one entry per virtual row", () => {
		const entries = Array.from({ length: 2 }, (_, index) => ({
			type: "media" as const,
			item: { id: `media-${index}` },
		}));

		expect(
			getMediaVirtualRowCount({
				entryCount: entries.length,
				mode: "list",
				columnCount: 4,
			}),
		).toBe(2);
		expect(
			getMediaVirtualRowEntries({
				entries,
				mode: "list",
				columnCount: 4,
				rowIndex: 1,
			}).map((entry) => (entry.type === "media" ? entry.item.id : "")),
		).toEqual(["media-1"]);
	});
});
