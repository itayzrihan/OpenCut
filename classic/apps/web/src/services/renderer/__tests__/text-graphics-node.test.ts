import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm/media-time";
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

import { TextGraphicsNode } from "../nodes/push-broll-node";
import { TextNode } from "../nodes/text-node";
import { RootNode } from "../nodes/root-node";
import { ColorNode } from "../nodes/color-node";
import { buildTransformFromParams } from "@/rendering";
import type { MeasuredTextElement } from "@/text/measure-element";
let buildFrameDescriptor: typeof import("../compositor/frame-descriptor").buildFrameDescriptor;
beforeAll(async () => {
	({ buildFrameDescriptor } = await import("../compositor/frame-descriptor"));
});
function target() {
	const transform = buildTransformFromParams({ params: {} });
	const text = new TextNode({
		id: "target",
		type: "text",
		name: "Caption",
		startTime: mediaTimeFromSeconds({ seconds: 1 }),
		duration: mediaTimeFromSeconds({ seconds: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		transform,
		opacity: 1,
		canvasCenter: { x: 540, y: 960 },
		canvasHeight: 1920,
	});
	// The descriptor test never draws this inert measured layout.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const measuredText = {
		visualRect: { left: -200, top: -50, width: 400, height: 100 },
	} as MeasuredTextElement;
	text.resolved = {
		transform,
		opacity: 0.8,
		textColor: "#ffffff",
		backgroundColor: "transparent",
		effectPasses: [],
		measuredText,
	};
	return text;
}
for (const edge of ["top", "bottom"] as const)
	test(`${edge} graphics move only the attached text in the opposite direction`, async () => {
		for (const progress of [0.1, 0.5, 1]) {
			const root = new RootNode({ duration: 720000 });
			root.add(new ColorNode({ color: "#ff0000" }));
			const wrapper = new TextGraphicsNode({
				timeOffset: 120000,
				duration: mediaTimeFromSeconds({ seconds: 5 }),
				edge,
				screenPercent: 20,
				transitionSeconds: 0.4,
			});
			wrapper.resolved = { progress };
			wrapper.add(target());
			wrapper.add(new ColorNode({ color: "#0000ff" }));
			root.add(wrapper);
			const { frame } = await buildFrameDescriptor({
				node: root,
				renderer: { width: 1080, height: 1920 },
			});
			const [background, text, graphics] = frame.items;
			if (
				background.type !== "layer" ||
				text.type !== "group" ||
				graphics.type !== "group"
			)
				throw new Error("Unexpected composition");
			expect(background.transform.centerY).toBe(960);
			const sign = edge === "top" ? -1 : 1;
			expect(text.transform?.centerY).toBeCloseTo(
				960 - (sign * (384 + 1920 * 0.012) * progress) / 2,
			);
			expect(graphics.transform?.centerY).toBeCloseTo(
				960 + sign * (50 + (1920 * 0.012) / 2) * progress,
			);
			expect(graphics.opacity).toBeCloseTo(progress * 0.8);
			expect(graphics.transform?.height).toBeCloseTo(384 * progress);
		}
	});
test("empty graphics preserve the text", async () => {
	const wrapper = new TextGraphicsNode({
		timeOffset: 120000,
		duration: mediaTimeFromSeconds({ seconds: 5 }),
		edge: "bottom",
		screenPercent: 20,
		transitionSeconds: 0.4,
	});
	wrapper.resolved = { progress: 1 };
	wrapper.add(target());
	const { frame } = await buildFrameDescriptor({
		node: wrapper,
		renderer: { width: 1080, height: 1920 },
	});
	expect(frame.items).toHaveLength(1);
	expect(frame.items[0].type).toBe("layer");
});
