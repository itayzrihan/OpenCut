import { describe, expect, test } from "bun:test";
import { isEditorSnapshotEqual } from "@/editor/snapshot";

describe("editor snapshot equality", () => {
	test("treats shallow object wrappers with stable values as unchanged", () => {
		const track = { id: "track-1" };
		const element = { id: "element-1" };

		expect(
			isEditorSnapshotEqual({
				a: { track, element },
				b: { track, element },
			}),
		).toBe(true);
	});

	test("detects changed object wrapper values", () => {
		const track = { id: "track-1" };

		expect(
			isEditorSnapshotEqual({
				a: { track, element: { id: "element-1" } },
				b: { track, element: { id: "element-1" } },
			}),
		).toBe(false);
	});

	test("does not shallow-compare non-plain objects", () => {
		expect(
			isEditorSnapshotEqual({
				a: new Date(0),
				b: new Date(0),
			}),
		).toBe(false);
	});
});
