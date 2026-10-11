import { expect, mock, test } from "bun:test";
import { wasm } from "../../../test-support/wasm";
mock.module("opencut-wasm", () => wasm);
const requests: Array<{ mediaId: string; time: number }> = [];
let pending: Promise<null> = Promise.resolve(null);
mock.module("@/services/video-cache/service", () => ({
	videoCache: {
		getFrameAt: (input: { mediaId: string; time: number }) => {
			requests.push(input);
			return pending;
		},
	},
}));
const { VideoLookahead } = await import("../video-lookahead");
const { BaseNode } = await import("@/services/renderer/nodes/base-node");
const { VideoNode } = await import("@/services/renderer/nodes/video-node");
const { PushBrollNode } =
	await import("@/services/renderer/nodes/push-broll-node");

function clip({
	mediaId,
	start,
	duration = 5,
	trim = 0,
	isPreview = true,
}: {
	mediaId: string;
	start: number;
	duration?: number;
	trim?: number;
	isPreview?: boolean;
}) {
	return new VideoNode({
		mediaId,
		url: `blob:${mediaId}`,
		timeOffset: start * 120000,
		duration: duration * 120000,
		trimStart: trim * 120000,
		trimEnd: 0,
		transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
		opacity: 1,
		isPreview,
		maxSourceSize: 1280,
	});
}
const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

test("prepares the next idle camera once, without seeking the playing camera or later cuts", async () => {
	requests.length = 0;
	const root = new BaseNode();
	root.add(clip({ mediaId: "A", start: 0, duration: 10 }));
	root.add(clip({ mediaId: "B", start: 10, duration: 1, trim: 23.11 }));
	root.add(clip({ mediaId: "B", start: 11, trim: 60 }));
	root.add(clip({ mediaId: "A", start: 11, trim: 90 }));
	const scheduler = new VideoLookahead({ node: root });
	scheduler.warm({ time: 6 * 120000 });
	expect(requests).toHaveLength(0);
	scheduler.warm({ time: 8 * 120000 });
	await settle();
	scheduler.warm({ time: 9 * 120000 });
	expect(requests).toEqual([
		{
			mediaId: "B",
			url: "blob:B",
			file: undefined,
			maxSourceSize: 1280,
			time: 23.11,
		},
	]);
	scheduler.dispose();
});

test("limits outstanding preparations and can prepare again after seeking backwards", async () => {
	requests.length = 0;
	let release!: (value: null) => void;
	pending = new Promise((resolve) => {
		release = resolve;
	});
	const root = new BaseNode();
	for (const mediaId of ["A", "B", "C"]) root.add(clip({ mediaId, start: 10 }));
	const scheduler = new VideoLookahead({ node: root });
	scheduler.warm({ time: 8 * 120000 });
	scheduler.warm({ time: 9 * 120000 });
	expect(requests).toHaveLength(2);
	release(null);
	await settle();
	pending = Promise.resolve(null);
	scheduler.warm({ time: 9 * 120000 });
	await settle();
	expect(requests).toHaveLength(3);
	scheduler.warm({ time: 6 * 120000 });
	scheduler.warm({ time: 8 * 120000 });
	expect(requests).toHaveLength(5);
	scheduler.dispose();
	await settle();
	scheduler.warm({ time: 9 * 120000 });
	expect(requests).toHaveLength(5);
});

test("does not speculate on export nodes or children with a different clock", () => {
	requests.length = 0;
	const root = new BaseNode();
	root.add(clip({ mediaId: "export", start: 2, isPreview: false }));
	const nested = new PushBrollNode({
		timeOffset: 99,
		duration: 100,
		edge: "top",
		screenPercent: 50,
		transitionSeconds: 0.2,
	});
	nested.add(clip({ mediaId: "nested", start: 2 }));
	root.add(nested);
	const scheduler = new VideoLookahead({ node: root });
	scheduler.warm({ time: 0 });
	expect(requests).toHaveLength(0);
	scheduler.dispose();
});

test("jump cuts in one source use two reusable decoder lanes while continuous cuts share one", async () => {
	requests.length = 0;
	const root = new BaseNode();
	const clips = [
		clip({ mediaId: "A", start: 0, duration: 10, trim: 0 }),
		clip({ mediaId: "A", start: 10, duration: 10, trim: 30 }),
		clip({ mediaId: "A", start: 20, duration: 10, trim: 60 }),
		clip({ mediaId: "A", start: 30, duration: 10, trim: 70 }),
	];
	for (const item of clips) root.add(item);
	const scheduler = new VideoLookahead({ node: root });
	expect(clips.map((item) => item.previewDecoderId)).toEqual([
		"A",
		"A::preview-cut-lane:1",
		"A",
		"A",
	]);
	scheduler.warm({ time: 8 * 120000 });
	await settle();
	expect(requests.map(({ mediaId, time }) => ({ mediaId, time }))).toEqual([
		{ mediaId: "A::preview-cut-lane:1", time: 30 },
	]);
	scheduler.warm({ time: 18 * 120000 });
	await settle();
	expect(requests.at(-1)?.mediaId).toBe("A");
	expect(requests.at(-1)?.time).toBe(60);
	scheduler.warm({ time: 28 * 120000 });
	expect(requests).toHaveLength(2); // Continuous source time at the last cut.
	scheduler.dispose();
});
