import { describe, expect, test } from "bun:test";
import {
	canBulkEditPropertiesSelection,
	isBulkEditablePropertiesTab,
} from "../bulk-selection";

function entries(...types: Array<"video" | "text" | "image">) {
	return types.map((type) => ({ element: { type } }));
}

describe("properties bulk selection", () => {
	test("allows a complete homogeneous video selection", () => {
		expect(
			canBulkEditPropertiesSelection({
				entries: entries("video", "video"),
				selectedCount: 2,
			}),
		).toBe(true);
	});

	test("keeps homogeneous text bulk editing enabled", () => {
		expect(
			canBulkEditPropertiesSelection({
				entries: entries("text", "text"),
				selectedCount: 2,
			}),
		).toBe(true);
	});

	test("rejects mixed element types", () => {
		expect(
			canBulkEditPropertiesSelection({
				entries: entries("video", "image"),
				selectedCount: 2,
			}),
		).toBe(false);
	});

	test("rejects a partial lookup of the current selection", () => {
		expect(
			canBulkEditPropertiesSelection({
				entries: entries("video"),
				selectedCount: 2,
			}),
		).toBe(false);
	});

	test("only exposes tabs that update every selected video", () => {
		for (const tabId of ["transform", "audio", "blending"]) {
			expect(
				isBulkEditablePropertiesTab({ elementType: "video", tabId }),
			).toBe(true);
		}

		for (const tabId of [
			"background-removal",
			"speed",
			"masks",
			"effects",
		]) {
			expect(
				isBulkEditablePropertiesTab({ elementType: "video", tabId }),
			).toBe(false);
		}
	});
});
