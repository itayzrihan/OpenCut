import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { mediaTime } from "@/wasm";

mock.module("../ripple-resize-wasm", () => ({
	rippleResizeWasm: {
		rippleInsertTime: ({
			clips,
			cutTime,
			insertedDuration,
		}: {
			clips: Array<{ id: string; startTime: number; duration: number }>;
			cutTime: number;
			insertedDuration: number;
		}) =>
			clips.map((clip) => {
				if (clip.startTime >= cutTime) {
					return { ...clip, startTime: clip.startTime + insertedDuration };
				}
				if (clip.startTime + clip.duration > cutTime) {
					return { ...clip, duration: clip.duration + insertedDuration };
				}
				return clip;
			}),
	},
}));

let buildRippleResizeUpdates: typeof import("../ripple-resize").buildRippleResizeUpdates;

beforeAll(async () => {
	({ buildRippleResizeUpdates } = await import("../ripple-resize"));
});

const t = (ticks: number) => mediaTime({ ticks });

describe("buildRippleResizeUpdates", () => {
	test("moves later layers and extends layers spanning the resized cut", () => {
		const tracks = {
			overlay: [
				{
					id: "overlay",
					type: "effect",
					name: "Overlay",
					hidden: false,
					elements: [
						{
							id: "spanning-effect",
							startTime: t(2),
							duration: t(20),
							trimStart: t(0),
							trimEnd: t(0),
						},
						{
							id: "ending-at-cut",
							startTime: t(5),
							duration: t(5),
							trimStart: t(0),
							trimEnd: t(0),
						},
					],
				},
				{
					id: "text",
					type: "text",
					name: "Text",
					hidden: false,
					elements: [
						{
							id: "later-text",
							startTime: t(12),
							duration: t(4),
							trimStart: t(0),
							trimEnd: t(0),
						},
					],
				},
			],
			main: {
				id: "main",
				type: "video",
				name: "Main",
				muted: false,
				hidden: false,
				elements: [
					{
						id: "target",
						startTime: t(0),
						duration: t(10),
						trimStart: t(0),
						trimEnd: t(3),
					},
					{
						id: "next-video",
						startTime: t(10),
						duration: t(5),
						trimStart: t(0),
						trimEnd: t(0),
					},
				],
			},
			audio: [
				{
					id: "audio",
					type: "audio",
					name: "Audio",
					muted: false,
					elements: [
						{
							id: "spanning-audio",
							startTime: t(0),
							duration: t(30),
							trimStart: t(0),
							trimEnd: t(0),
						},
					],
				},
			],
		} as SceneTracks;

		const updates = buildRippleResizeUpdates({
			tracks,
			cutTime: t(10),
			insertedDuration: t(3),
			selectedUpdates: [
				{
					trackId: "main",
					elementId: "target",
					patch: {
						startTime: t(0),
						duration: t(13),
						trimStart: t(0),
						trimEnd: t(0),
					},
				},
			],
		});
		const byId = new Map(updates.map((update) => [update.elementId, update]));

		expect(byId.get("target")?.patch.duration).toBe(t(13));
		expect(byId.get("next-video")?.patch.startTime).toBe(t(13));
		expect(byId.get("later-text")?.patch.startTime).toBe(t(15));
		expect(byId.get("spanning-effect")?.patch.duration).toBe(t(23));
		expect(byId.get("spanning-audio")?.patch.duration).toBe(t(33));
		expect(byId.has("ending-at-cut")).toBe(false);
	});
});
