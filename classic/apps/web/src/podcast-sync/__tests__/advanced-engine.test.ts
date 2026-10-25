// @opencut-test-wasm: real
import { expect, mock, test } from "bun:test";
import {
	groupPodcastRecordings,
	podcastMulticamDefaults,
	analyzePodcastMulticam,
} from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
const reads: string[] = [];
const precisionSegments: Array<Array<{ start: number; duration: number }>> = [];
mock.module("../sync-jobs", () => ({
	mapConcurrent: async ({ items, task, signal }: any) =>
		Promise.all(items.map((item: any) => task(item, signal))),
	runSyncWorker: async ({ message }: any) => {
		if (message.type === "read") {
			reads.push(message.asset.name);
			return new Float32Array(
				message.asset.name.startsWith("Camera")
					? 10000
					: message.asset.name.includes("1705")
						? 10000
						: 180015,
			).fill(0.5);
		}
		if (message.type === "align") {
			expect(message.envelopes.map((e: Float32Array) => e.length)).toEqual([
				10000, 10000, 190015, 190015,
			]);
			return {
				offsets: [0, 10, -1790.15, 3.123],
				confidence: [1, 1, 1, 1],
				parents: [undefined, 0, 0, 0],
				referenceIndex: 0,
			};
		}
		if (message.type === "precision") {
			precisionSegments.push(message.targetSegments);
			expect(message.referenceSegments[0].asset.type).toBe("video");
			return { offsetSeconds: 0, confidence: 1 };
		}
		if (message.type === "route") {
			expect(message.envelopes).toHaveLength(2);
			expect(message.advanced.microphoneIds).toHaveLength(2);
			return analyzePodcastMulticam({
				...message,
				envelopes: message.envelopes.map((e: Float32Array) => Array.from(e)),
			});
		}
	},
}));
const { runPodcastAlignment, runPodcastMulticam } = await import("../engine");
test("segmented logical microphones keep all physical bindings and staggered starts", async () => {
	const cameras: MediaAsset[] = [1, 2].map((i) => ({
		id: `v${i}`,
		name: `Camera ${i}`,
		type: "video",
		duration: 100,
		hasAudio: true,
	}));
	const recordings: MediaAsset[] = ["9P8H", "AHQC"].flatMap((token) =>
		[0, 1].map((i) => ({
			id: `${token}-${i}`,
			name: `20260720_${i ? "1705" : "1635"}_${i ? "0006" : "0005"}_32Float_${token}.wav`,
			type: "audio" as const,
			duration: i ? 100 : 1800.15,
			bindingRevision: 2,
		})),
	);
	const grouped = groupPodcastRecordings({
		recordings: recordings.map((a) => ({
			mediaId: a.id,
			name: a.name,
			duration: a.duration!,
			bindingRevision: 2,
		})),
	});
	expect(grouped.issues).toEqual([]);
	const channels = cameras.map((video, i) => ({
		id: video.id,
		name: video.name,
		video,
		audio: recordings[i * 2]!,
	}));
	const advanced = {
		microphones: grouped.microphones,
		routing: {
			microphoneIds: grouped.microphones.map((m) => m.id),
			cameras: channels.map((c) => ({
				channelId: c.id,
				microphoneIds: grouped.microphones.map((m) => m.id),
			})),
		},
		assets: [...cameras, ...recordings],
	};
	const settings = podcastMulticamDefaults({ quick: true });
	const alignment = await runPodcastAlignment({ channels, settings, advanced });
	expect(reads.length).toBe(6);
	expect(new Set(reads).size).toBe(6);
	expect(alignment.bindings).toEqual(
		Object.fromEntries(
			advanced.assets.map((a) => [a.id, a.bindingRevision ?? 0]),
		),
	);
	expect(alignment.advanced?.starts).toEqual({
		"20260720-9P8H": -1790.15,
		"20260720-AHQC": 3.123,
	});
	expect(
		precisionSegments.some((s) => s.length === 2 && s[1]!.start === 1800.15),
	).toBe(true);
	const result = await runPodcastMulticam({ channels, settings, alignment });
	expect(result.advanced).toEqual(alignment.advanced);
	expect(result.cuts.reduce((sum, c) => sum + c.duration, 0)).toBe(100);
	recordings[0]!.bindingRevision = 3;
	await expect(
		runPodcastAlignment({ channels, settings, advanced }),
	).rejects.toThrow("Microphone recording changed");
});
