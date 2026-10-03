import { test, expect } from "bun:test";
import {
	encodeBrowserGraph,
	decodeBrowserGraph,
} from "./browser-archive-codec";
import { sameBrowserRecord } from "./browser-records";

test("portable browser archive restores binary values, cycles and non-JSON values without changing their types", async () => {
	const objects = new Map<string, Blob>();
	const value: Record<string, unknown> = {
		binary: new Uint16Array([1, 65535]),
		blob: new Blob(["exact bytes"], { type: "audio/wav" }),
		file: new File(["font"], "original.ttf", {
			lastModified: 123,
			type: "font/ttf",
		}),
		date: new Date(1234),
		undefined,
		infinity: Infinity,
		negativeZero: -0,
		big: 999999999999999999n,
		map: new Map([["a", new Set([1, 2])]]),
	};
	value.self = value;
	const graph = await encodeBrowserGraph(value, async (blob) => {
		const id = crypto.randomUUID();
		objects.set(id, blob);
		return id;
	});
	const encoded = JSON.stringify(graph);
	const restored = await decodeBrowserGraph(
		JSON.parse(encoded),
		async (id) => objects.get(id)!,
	);
	expect(await sameBrowserRecord(value, restored)).toBe(true);
	expect((restored as Record<string, unknown>).self).toBe(restored);
	expect(objects.size).toBe(3);
	await expect(
		encodeBrowserGraph({ bad: () => {} }, async () => "unused"),
	).rejects.toThrow("Unsupported");
});
