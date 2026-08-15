import { describe, expect, test } from "bun:test";
import { validateReorganizeTakesPlan } from "../reorganize-takes-plan";

const phraseIds = ["a", "b", "c"];

describe("validateReorganizeTakesPlan", () => {
	test("accepts a valid permutation with no cuts or clusters", () => {
		const plan = validateReorganizeTakesPlan({
			value: { order: ["b", "a", "c"], cut: [], takeClusters: [] },
			phraseIds,
		});
		expect(plan.order).toEqual(["b", "a", "c"]);
	});

	test("accepts cut ids removed from order", () => {
		const plan = validateReorganizeTakesPlan({
			value: { order: ["a", "c"], cut: ["b"], takeClusters: [] },
			phraseIds,
		});
		expect(plan.order).toEqual(["a", "c"]);
		expect(plan.cut).toEqual(["b"]);
	});

	test("accepts take clusters referencing kept ids", () => {
		const plan = validateReorganizeTakesPlan({
			value: {
				order: ["a", "b", "c"],
				cut: [],
				takeClusters: [{ ids: ["a", "b"], label: "Intro" }],
			},
			phraseIds,
		});
		expect(plan.takeClusters).toEqual([{ ids: ["a", "b"], label: "Intro" }]);
	});

	test("rejects an id in order that doesn't exist", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: { order: ["a", "z"], cut: ["b", "c"], takeClusters: [] },
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects an order that is missing a kept phrase", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: { order: ["a"], cut: [], takeClusters: [] },
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects a duplicate id in order", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: { order: ["a", "a", "b"], cut: ["c"], takeClusters: [] },
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects an id that is both ordered and cut", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: { order: ["a", "b"], cut: ["b"], takeClusters: [] },
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects a cluster id that overlaps another cluster", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: {
					order: ["a", "b", "c"],
					cut: [],
					takeClusters: [
						{ ids: ["a", "b"] },
						{ ids: ["b", "c"] },
					],
				},
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects a cluster id for a phrase that was cut", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: {
					order: ["a", "c"],
					cut: ["b"],
					takeClusters: [{ ids: ["a", "b"] }],
				},
				phraseIds,
			}),
		).toThrow();
	});

	test("rejects a cluster with fewer than two ids", () => {
		expect(() =>
			validateReorganizeTakesPlan({
				value: {
					order: ["a", "b", "c"],
					cut: [],
					takeClusters: [{ ids: ["a"] }],
				},
				phraseIds,
			}),
		).toThrow();
	});
});
