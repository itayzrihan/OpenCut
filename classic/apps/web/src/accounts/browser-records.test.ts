import { expect, test } from "bun:test";
import { sameBrowserRecord } from "./browser-records";

test("browser verification compares binary records, dates, containers and cycles", async () => {
	const value = {
		media: new Blob(["original"], { type: "audio/wav" }),
		bytes: new Uint16Array([7, 500]),
		date: new Date(1234),
		map: new Map([["x", new Set([1, 2])]]),
	};
	expect(await sameBrowserRecord({ left: value, right: structuredClone(value) })).toBe(true);
	expect(
		await sameBrowserRecord({ left: value, right: {
			...value,
			media: new Blob(["modified"], { type: "audio/wav" }),
		} }),
	).toBe(false);
	expect(
		await sameBrowserRecord({ left: value, right: {
			...value,
			bytes: new Uint16Array([7, 501]),
		} }),
	).toBe(false);
	expect(await sameBrowserRecord({ left: { a: 1, b: 2 }, right: { b: 2, a: 1 } })).toBe(true);
	const circular: { self?: unknown } = {};
	circular.self = circular;
	expect(await sameBrowserRecord({ left: circular, right: structuredClone(circular) })).toBe(
		true,
	);
	expect(await sameBrowserRecord({ left: [undefined], right: new Array(2) })).toBe(false);
});
