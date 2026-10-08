/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- browser font adapter test doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadFullFont, loadFonts } from "../google-fonts";

const original = {
	document: globalThis.document,
	FontFace: globalThis.FontFace,
	fetch: globalThis.fetch,
};
afterEach(() => {
	globalThis.document = original.document;
	globalThis.FontFace = original.FontFace;
	globalThis.fetch = original.fetch;
});
test("saved Assistant Bold captions load the bundled face without a font service or stylesheet", async () => {
	const faces: string[] = [];
	const loads: string[] = [];
	globalThis.FontFace = class {
		// eslint-disable-next-line opencut/prefer-object-params -- Mirrors the native FontFace constructor.
		constructor(
			public family: string,
			public source: string,
		) {
			faces.push(source);
		}
		async load() {
			return this;
		}
	} as unknown as typeof FontFace;
	globalThis.document = {
		fonts: {
			add: () => {},
			load: async (font: string) => {
				loads.push(font);
				return [{}];
			},
		},
	} as unknown as Document;
	globalThis.fetch = mock(() => {
		throw new Error("No external font fetch expected");
	}) as unknown as typeof fetch;
	await loadFonts({ families: ["Assistant Bold"] });
	await loadFullFont({ family: "Assistant Bold" });
	expect(faces).toEqual(['url("/fonts/assistant/Assistant-Bold.ttf")']);
	expect(loads).toHaveLength(2); // Latin and Hebrew readiness, then the cached face.
	expect(globalThis.fetch).not.toHaveBeenCalled();
});
test("shipped asset is a static 700-weight font with Hebrew character coverage", () => {
	const bytes = readFileSync(
		new URL(
			"../../../public/fonts/assistant/Assistant-Bold.ttf",
			import.meta.url,
		),
	);
	const tables = new Map<string, number>();
	for (let index = 0; index < bytes.readUInt16BE(4); index++) {
		const record = 12 + index * 16;
		tables.set(
			bytes.toString("ascii", record, record + 4),
			bytes.readUInt32BE(record + 8),
		);
	}
	expect(bytes.readUInt16BE(tables.get("OS/2")! + 4)).toBe(700);
	expect(tables.has("fvar")).toBe(false);
	const cmap = tables.get("cmap")!;
	let hebrew = false;
	for (let index = 0; index < bytes.readUInt16BE(cmap + 2); index++) {
		const sub = cmap + bytes.readUInt32BE(cmap + 4 + index * 8 + 4);
		if (bytes.readUInt16BE(sub) !== 4) continue;
		const segments = bytes.readUInt16BE(sub + 6) / 2;
		for (let segment = 0; segment < segments; segment++) {
			const end = bytes.readUInt16BE(sub + 14 + segment * 2);
			const start = bytes.readUInt16BE(sub + 16 + segments * 2 + segment * 2);
			if (start <= 0x5d0 && end >= 0x5ea) hebrew = true;
		}
	}
	expect(hebrew).toBe(true);
});
