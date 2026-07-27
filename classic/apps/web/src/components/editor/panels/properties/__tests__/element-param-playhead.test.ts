import { describe, expect, test } from "bun:test";
import { shouldUseLiveElementParamPlayhead } from "@/components/editor/panels/properties/element-param-playhead";

describe("element param playhead gating", () => {
	test("tracks playhead for visible keyframable params", () => {
		expect(
			shouldUseLiveElementParamPlayhead({
				params: [{ keyframable: true }],
				isBulk: false,
				isScopedText: false,
			}),
		).toBe(true);
	});

	test("treats params as keyframable by default", () => {
		expect(
			shouldUseLiveElementParamPlayhead({
				params: [{}],
				isBulk: false,
				isScopedText: false,
			}),
		).toBe(true);
	});

	test("skips playhead tracking for bulk scoped and non-keyframable panels", () => {
		expect(
			shouldUseLiveElementParamPlayhead({
				params: [{ keyframable: true }],
				isBulk: true,
				isScopedText: false,
			}),
		).toBe(false);
		expect(
			shouldUseLiveElementParamPlayhead({
				params: [{ keyframable: true }],
				isBulk: false,
				isScopedText: true,
			}),
		).toBe(false);
		expect(
			shouldUseLiveElementParamPlayhead({
				params: [{ keyframable: false }],
				isBulk: false,
				isScopedText: false,
			}),
		).toBe(false);
	});
});
