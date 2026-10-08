import { wasm } from "../../../../test-support/wasm";
import { beforeAll, expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	...wasm,
	initCompositor: () => undefined,
	getCompositorCanvas: () => null,
	getLastFrameProfile: () => null,
	releaseTexture: () => undefined,
	renderFrame: () => undefined,
	resizeCompositor: () => undefined,
	uploadTexture: () => undefined,
	applyEffectPasses: ({ source }: { source: unknown }) => source,
	applyMaskFeather: ({ mask }: { mask: unknown }) => mask,
	initializeGpu: async () => undefined,
	refineBackgroundAlpha: () => undefined,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	formatTimecode: () => "00:00:00:00",
	roundFrameTime: ({ time }: { time: number }) => time,
	normalizeTextLayerWordIds: <T extends { wordRuns: Array<{ id: string }> }>(
		options: T,
	) =>
		options.wordRuns.map((word, previousWordIndex) => ({
			previousWordIndex,
			id: word.id,
		})),
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	reconcileTextContentWords: () => [],
	fitTextLayerWordsToSpan: () => [],
	textLayerDurationForWords: <
		T extends {
			duration: number;
			wordRuns: Array<{ startTime?: number; endTime?: number }>;
		},
	>(
		options: T,
	) =>
		Math.max(
			options.duration,
			...options.wordRuns.map((word) => word.endTime ?? word.startTime ?? 0),
		),
	defaultBackgroundRemovalSettings: () => ({
		enabled: false,
		mode: "remove",
		quality: "balanced",
		maskThreshold: 0.5,
		edgeContrast: 1,
		edgeFeather: 0,
		temporalSmoothing: 0,
		blurStrength: 0,
	}),
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({ clips: options.clips, timelineDuration: 0 }),
	planBackgroundRemovalDuplicate: () => ({
		kind: "existingTrack",
		trackId: "video",
	}),
	resolveBackgroundRemovalSettings: <T>(settings: T) => ({
		...settings,
		inputSize: 256,
		previewFps: 15,
		cacheEntries: 2,
		blurSigma: 0,
	}),
}));

import { PushBrollNode } from "../nodes/push-broll-node";
import { RootNode } from "../nodes/root-node";
import { ColorNode } from "../nodes/color-node";
let buildFrameDescriptor: typeof import("../compositor/frame-descriptor").buildFrameDescriptor;
beforeAll(async () => {
	({ buildFrameDescriptor } = await import("../compositor/frame-descriptor"));
});
for (const edge of ["top", "bottom"] as const)
	test(`${edge} B-roll meets the main frame throughout the reveal`, async () => {
		for (const progress of [0.1, 0.5, 1]) {
			const root = new RootNode({ duration: 600000 });
			root.add(new ColorNode({ color: "#ff0000" }));
			const broll = new PushBrollNode({
				timeOffset: 0,
				duration: 600000,
				edge,
				screenPercent: 40,
				transitionSeconds: 0.4,
			});
			broll.resolved = { progress };
			broll.add(new ColorNode({ color: "#0000ff" }));
			root.add(broll);
			const { frame } = await buildFrameDescriptor({
				node: root,
				renderer: { width: 1080, height: 1920 },
			});
			const [main, band] = frame.items;
			if (main.type !== "group" || band.type !== "group")
				throw new Error("Expected atomic groups");
			const revealed = 1920 * 0.4 * progress;
			expect(main.transform?.centerY).toBeCloseTo(
				960 + (edge === "top" ? revealed : -revealed),
			);
			expect(band.clip?.[3]).toBeCloseTo(revealed);
			expect(band.clip?.[1]).toBeCloseTo(edge === "top" ? 0 : 1920 - revealed);
			// No independently animated edge can expose a gap.
			expect(
				edge === "top"
					? main.transform!.centerY - 960
					: main.transform!.centerY + 960,
			).toBeCloseTo(
				edge === "top" ? band.clip![1] + band.clip![3] : band.clip![1],
			);
		}
	});
test("unfilled nested scene keeps the main video in place", async () => {
	const root = new RootNode({ duration: 600000 });
	root.add(new ColorNode({ color: "#ff0000" }));
	const broll = new PushBrollNode({
		timeOffset: 0,
		duration: 600000,
		edge: "top",
		screenPercent: 40,
		transitionSeconds: 0.4,
	});
	broll.resolved = { progress: 1 };
	root.add(broll);
	const { frame } = await buildFrameDescriptor({
		node: root,
		renderer: { width: 1080, height: 1920 },
	});
	expect(frame.items).toHaveLength(1);
	expect(frame.items[0].type).toBe("layer");
});

test("runtime uses Classic ticks for entry timing", async () => {
	const { resolveRenderTree } = await import("../resolve");
	const node = new PushBrollNode({
		timeOffset: 120000,
		duration: 600000,
		edge: "top",
		screenPercent: 40,
		transitionSeconds: 0.4,
	});
	await resolveRenderTree({
		node,
		renderer: { width: 1080, height: 1920 },
		time: 144000,
	});
	expect(node.resolved?.progress).toBeCloseTo(0.5);
	await resolveRenderTree({
		node,
		renderer: { width: 1080, height: 1920 },
		time: 120000,
	});
	expect(node.resolved).toBeNull();
});
