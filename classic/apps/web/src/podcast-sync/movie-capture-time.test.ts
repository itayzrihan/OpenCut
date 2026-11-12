import { expect, test } from "bun:test";
import { readMovieCaptureTime } from "./movie-capture-time";

function box(name: string, payload: Uint8Array, extended = false) {
	const header = extended ? 16 : 8;
	const data = new Uint8Array(header + payload.length);
	const view = new DataView(data.buffer);
	view.setUint32(0, extended ? 1 : data.length);
	data.set(new TextEncoder().encode(name), 4);
	if (extended) view.setBigUint64(8, BigInt(data.length));
	data.set(payload, header);
	return data;
}

test("movie creation time survives large media boxes and both timestamp layouts", async () => {
	for (const version of [0, 1]) {
		const time = Date.UTC(2026, 3, 12, 10, 20);
		const stamp = time / 1000 + 2_082_844_800;
		const payload = new Uint8Array(12);
		const view = new DataView(payload.buffer);
		view.setUint8(0, version);
		if (version) view.setBigUint64(4, BigInt(stamp));
		else view.setUint32(4, stamp);
		const clip = new Blob([
			box("ftyp", new Uint8Array(16)),
			box("mdat", new Uint8Array(500_000), true),
			box("moov", box("mvhd", payload)),
		]);
		const reads: number[] = [];
		const bounded = {
			size: clip.size,
			slice(start: number, end: number) {
				reads.push(end - start);
				return clip.slice(start, end);
			},
		} as Blob;
		expect(await readMovieCaptureTime(bounded)).toBe(time);
		expect(reads.every((size) => size <= 16)).toBe(true);
	}
});

test("malformed or unset movie headers produce no timing hint", async () => {
	const broken = box("moov", box("mvhd", new Uint8Array(12)));
	const intact = new Blob([broken]);
	expect(await readMovieCaptureTime(intact)).toBeNull();
	new DataView(broken.buffer).setUint32(0, broken.length + 100);
	expect(await readMovieCaptureTime(new Blob([broken]))).toBeNull();
});
