import { expect, test } from "bun:test";
import { reuseAudioContext } from "./overlap-reader";
import { createTranscriptionLimit } from "./request-limit";
test("overlap reuse preserves every sample including boundaries and detached prior output", async () => {
	const ranges: number[][] = [];
	const read = reuseAudioContext({
		sampleRate: 2,
		contextSeconds: 10,
		read: async ({ start, end }) => {
			ranges.push([start, end]);
			return Float32Array.from(
				{ length: (end - start) * 2 },
				(_, i) => start * 2 + i,
			);
		},
	});
	const first = await read({ start: 0, end: 65 });
	structuredClone(first, { transfer: [first.buffer] });
	const second = await read({ start: 55, end: 125 });
	expect([...second]).toEqual(Array.from({ length: 140 }, (_, i) => 110 + i));
	expect(ranges).toEqual([
		[0, 65],
		[65, 125],
	]);
	await read({ start: 55, end: 125 }); // retry cannot use a non-covering tail
	expect(ranges.at(-1)).toEqual([55, 125]);
});
test("account provider limit rejects a third request, isolates accounts and releases errors", async () => {
	const limit = createTranscriptionLimit();
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const run = async () => {
		await gate;
		return new Response();
	};
	const a = limit({ account: "a", run });
	const b = limit({ account: "a", run });
	expect((await limit({ account: "a", run })).status).toBe(429);
	expect(
		(await limit({ account: "b", run: async () => new Response() })).status,
	).toBe(200);
	release();
	await Promise.all([a, b]);
	await expect(
		limit({
			account: "a",
			run: async () => {
				throw new Error("failed");
			},
		}),
	).rejects.toThrow("failed");
	expect(
		(await limit({ account: "a", run: async () => new Response() })).status,
	).toBe(200);
});
