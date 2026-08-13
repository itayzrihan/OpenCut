/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- inert canvas stand-ins are never drawn in this descriptor-only test */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
	mediaTimeFromSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm/media-time";

mock.module("opencut-wasm", () => ({
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

let buildFrameDescriptor: typeof import("@/services/renderer/compositor/frame-descriptor").buildFrameDescriptor;
let resolveRenderTree: typeof import("@/services/renderer/resolve").resolveRenderTree;
let SpeakerFrameBreakoutNode: typeof import("@/services/renderer/nodes/speaker-frame-breakout-node").SpeakerFrameBreakoutNode;
let readSpeakerFrameBreakoutSettings: typeof import("@/simple-advanced-layers/speaker-frame-breakout").readSpeakerFrameBreakoutSettings;
let SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS: typeof import("@/simple-advanced-layers/speaker-frame-breakout").SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS;
let backgroundRemovalService: typeof import("@/services/background-removal").backgroundRemovalService;
let videoCache: typeof import("@/services/video-cache/service").videoCache;

beforeAll(async () => {
	({ buildFrameDescriptor } = await import(
		"@/services/renderer/compositor/frame-descriptor"
	));
	({ resolveRenderTree } = await import("@/services/renderer/resolve"));
	({ SpeakerFrameBreakoutNode } = await import(
		"@/services/renderer/nodes/speaker-frame-breakout-node"
	));
	({
		readSpeakerFrameBreakoutSettings,
		SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	} = await import("@/simple-advanced-layers/speaker-frame-breakout"));
	({ backgroundRemovalService } = await import(
		"@/services/background-removal"
	));
	({ videoCache } = await import("@/services/video-cache/service"));
}, 15_000);

const renderer = {
	width: 1080,
	height: 1920,
};

describe("Speaker Frame Breakout renderer node", () => {
	test("fails export instead of silently dropping a stale breakout", async () => {
		const node = new SpeakerFrameBreakoutNode({
			layerId: "stale-smart-layer",
			timeOffset: ZERO_MEDIA_TIME,
			duration: mediaTimeFromSeconds({ seconds: 6 }),
			settings: readSpeakerFrameBreakoutSettings({
				params: SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
			}),
			currentSourceSignature: "new-signature",
			isAppliedAndCurrent: false,
			isPreview: false,
			sources: [],
		});

		await expect(
			resolveRenderTree({
				node,
				renderer,
				time: ZERO_MEDIA_TIME,
			}),
		).rejects.toThrow(
			"Speaker Frame Breakout source changed after Apply. Reapply the layer before export.",
		);
	});

	test("rebuilds a missing prepared matte during export", async () => {
		const fallbackMask = {
			canvas: {} as OffscreenCanvas,
			width: 256,
			height: 256,
			contentHash: "rebuilt",
		};
		const sourceCanvas = {
			width: 1920,
			height: 1080,
		} as OffscreenCanvas;
		const originalGetFrameAt = videoCache.getFrameAt.bind(videoCache);
		const originalGetPreparedMaskFrame =
			backgroundRemovalService.getPreparedMaskFrame.bind(
				backgroundRemovalService,
			);
		const originalHydratePreparedGroup =
			backgroundRemovalService.hydratePreparedGroup.bind(
				backgroundRemovalService,
			);
		const originalSegmentFrame =
			backgroundRemovalService.segmentFrame.bind(backgroundRemovalService);
		let segmentOptions: Parameters<
			typeof backgroundRemovalService.segmentFrame
		>[0] | null = null;
		videoCache.getFrameAt = async () =>
			({ canvas: sourceCanvas }) as Awaited<
				ReturnType<typeof videoCache.getFrameAt>
			>;
		backgroundRemovalService.getPreparedMaskFrame = () => null;
		backgroundRemovalService.hydratePreparedGroup = async () => false;
		backgroundRemovalService.segmentFrame = async (options) => {
			segmentOptions = options;
			return fallbackMask;
		};
		try {
			const duration = mediaTimeFromSeconds({ seconds: 6 });
			const node = new SpeakerFrameBreakoutNode({
				layerId: "smart-layer",
				timeOffset: ZERO_MEDIA_TIME,
				duration,
				settings: readSpeakerFrameBreakoutSettings({
					params: {
						...SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
						matteApplied: true,
						matteCacheKey: "speaker-frame-breakout:smart-layer:signature",
					},
				}),
				currentSourceSignature: "signature",
				isAppliedAndCurrent: true,
				isPreview: false,
				sources: [
					{
						trackId: "video-track",
						trackIndex: 1,
						elementId: "source",
						mediaId: "media",
						url: "blob:source",
						duration,
						timeOffset: ZERO_MEDIA_TIME,
						trimStart: ZERO_MEDIA_TIME,
						trimEnd: ZERO_MEDIA_TIME,
						transform: {
							position: { x: 0, y: 0 },
							scaleX: 1,
							scaleY: 1,
							rotate: 0,
							perspectiveX: 0,
							perspectiveY: 0,
						},
						opacity: 1,
						blendMode: "normal",
						effects: [],
						cameraDepth: 0,
						cameraLocked: false,
					},
				],
			});

			await resolveRenderTree({
				node,
				renderer,
				time: mediaTimeFromSeconds({ seconds: 1 }),
			});

			expect(node.resolved?.mask).toBe(fallbackMask);
			expect(segmentOptions).toMatchObject({
				mediaId: "media",
				isPreview: true,
				temporalSequenceKey:
					"speaker-frame-breakout:smart-layer:signature",
			});
		} finally {
			videoCache.getFrameAt = originalGetFrameAt;
			backgroundRemovalService.getPreparedMaskFrame =
				originalGetPreparedMaskFrame;
			backgroundRemovalService.hydratePreparedGroup =
				originalHydratePreparedGroup;
			backgroundRemovalService.segmentFrame = originalSegmentFrame;
		}
	});

	test("emits one faded group while preserving source visual styling", async () => {
		const duration = mediaTimeFromSeconds({ seconds: 6 });
		const node = new SpeakerFrameBreakoutNode({
			layerId: "smart-layer",
			timeOffset: ZERO_MEDIA_TIME,
			duration,
			settings: readSpeakerFrameBreakoutSettings({
				params: SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
			}),
			currentSourceSignature: "signature",
			isAppliedAndCurrent: true,
			isPreview: true,
			sources: [],
		});
		node.resolved = {
			source: {} as CanvasImageSource,
			sourceWidth: 1920,
			sourceHeight: 1080,
			sourceElementId: "source",
			sourceMediaId: "media",
			sourceTime: 1,
			backgroundParams: {
				preset: "grid",
				colorA: "#F8F8F5",
				colorB: "#D8DAD5",
				colorC: "#FFFFFF",
				density: 48,
				intensity: 12,
				scale: 52,
				seed: 7,
			},
			mask: {
				canvas: {} as OffscreenCanvas,
				width: 512,
				height: 512,
				contentHash: "matte",
			},
			transform: {
				position: { x: 12, y: 410 },
				scaleX: 0.7,
				scaleY: 0.7,
				rotate: 8,
				perspectiveX: 4,
				perspectiveY: -3,
			},
			cropTop: 0.22,
			cornerRadius: 0.08,
			opacity: 0.5,
			sourceOpacity: 0.7,
			blendMode: "screen",
			effectPassGroups: [
				[
					{
						shader: "scanlines",
						uniforms: { u_intensity: 0.4 },
					},
				],
			],
			cameraDepth: 1.2,
			cameraLocked: false,
			localTime: 1,
		};

		const { frame } = await buildFrameDescriptor({ node, renderer });

		expect(frame.items).toHaveLength(1);
		const group = frame.items[0];
		if (group?.type !== "group") {
			throw new Error("Expected one grouped smart-layer descriptor");
		}
		expect(group.opacity).toBe(0.5);
		expect(group.items).toHaveLength(3);
		expect(group.items[0]).toMatchObject({
			type: "layer",
			opacity: 1,
		});
		expect(group.items[1]).toMatchObject({
			type: "layer",
			opacity: 0.7,
			blendMode: "screen",
			effectPassGroups: [
				[
					{
						shader: "scanlines",
						uniforms: { u_intensity: 0.4 },
					},
				],
			],
			transform: {
				rotationDegrees: 8,
				perspectiveXDegrees: 4,
				perspectiveYDegrees: -3,
			},
		});
		expect(group.items[2]).toMatchObject({
			type: "layer",
			opacity: 0.7,
			blendMode: "screen",
			sourceMask: { inverted: false },
			mask: { inverted: false },
		});

		const preparedMask = node.resolved.mask;
		node.resolved.mask = null;
		const { frame: fallbackFrame } = await buildFrameDescriptor({
			node,
			renderer,
		});
		const fallbackGroup = fallbackFrame.items[0];
		if (fallbackGroup?.type !== "group") {
			throw new Error("Expected fallback smart-layer group without a matte");
		}
		expect(fallbackGroup.items).toHaveLength(2);
		expect(fallbackGroup.items[0]).toMatchObject({
			type: "layer",
			opacity: 1,
		});
		expect(fallbackGroup.items[1]).toMatchObject({
			type: "layer",
			opacity: 0.7,
			blendMode: "screen",
		});

		for (let frameIndex = 0; frameIndex < 8; frameIndex++) {
			node.resolved.mask =
				frameIndex % 3 === 0 ? null : preparedMask;
			const { frame: sequenceFrame } = await buildFrameDescriptor({
				node,
				renderer,
			});
			const sequenceGroup = sequenceFrame.items[0];
			expect(sequenceGroup?.type).toBe("group");
			if (sequenceGroup?.type === "group") {
				expect(sequenceGroup.items.length).toBeGreaterThanOrEqual(2);
			}
		}
	});
});
