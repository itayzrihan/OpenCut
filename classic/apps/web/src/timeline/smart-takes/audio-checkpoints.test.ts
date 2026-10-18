import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
	IndexedAudioCheckpoints,
	packAudioFrames,
	unpackAudioFrames,
	audioCheckpointKey,
} from "./audio-checkpoints";
const frames = [
	{
		start: 0,
		end: 0.019061234567890123,
		rms: 0.1234567890123456,
		peak: 0.8765432109876543,
		zeroCrossingRate: 0.06250000000001,
	},
];
test("audio checkpoint survives a new cache instance with exact timing/features and account isolation", async () => {
	const factory = new IDBFactory();
	const a = new IndexedAudioCheckpoints({ factory, databaseName: "account-a" });
	await a.write({ key: "source-window", duration: 30, frames });
	const restored = new IndexedAudioCheckpoints({
		factory,
		databaseName: "account-a",
	});
	expect(await restored.read({ key: "source-window", duration: 30 })).toEqual(
		frames,
	);
	expect(
		await restored.read({ key: "source-window", duration: 31 }),
	).toBeUndefined();
	expect(
		await new IndexedAudioCheckpoints({
			factory,
			databaseName: "account-b",
		}).read({ key: "source-window", duration: 30 }),
	).toBeUndefined();
});
test("audio cache atomically evicts oldest artifacts within byte/count budgets", async () => {
	let clock = 0;
	const cache = new IndexedAudioCheckpoints({
		factory: new IDBFactory(),
		databaseName: "budget",
		maxBytes: 80,
		maxEntries: 2,
		now: () => ++clock,
	});
	for (const key of ["a", "b"])
		await cache.write({ key, duration: 30, frames });
	await cache.read({ key: "a", duration: 30 });
	await cache.write({ key: "c", duration: 30, frames });
	expect(await cache.read({ key: "a", duration: 30 })).toEqual(frames);
	expect(await cache.read({ key: "b", duration: 30 })).toBeUndefined();
	expect(await cache.read({ key: "c", duration: 30 })).toEqual(frames);
});
test("corrupted/missing/overlapping samples are never restored as false silence and source binding changes invalidate keys", async () => {
	expect(
		unpackAudioFrames({
			data: new Float64Array([0, 1, NaN, 0, 0]),
			duration: 30,
		}),
	).toBeUndefined();
	expect(() =>
		packAudioFrames({
			frames: [...frames, { ...frames[0], start: 0, end: 1 }],
			duration: 30,
		}),
	).toThrow();
	expect(() =>
		packAudioFrames({ frames: [{ ...frames[0], end: 31 }], duration: 30 }),
	).toThrow();
	const key = await audioCheckpointKey({
		value: {
			source: "words-a",
			bindingRevision: 1,
			start: 30,
			end: 60,
			rate: 1,
		},
	});
	expect(
		await audioCheckpointKey({
			value: {
				source: "words-a",
				bindingRevision: 2,
				start: 30,
				end: 60,
				rate: 1,
			},
		}),
	).not.toBe(key);
	expect(
		await audioCheckpointKey({
			value: {
				source: "words-b",
				bindingRevision: 1,
				start: 30,
				end: 60,
				rate: 1,
			},
		}),
	).not.toBe(key);
});
