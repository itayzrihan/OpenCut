import { describe, expect, test } from "bun:test";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import type {
	EffectElement,
	EffectTrack,
	GraphicElement,
	GraphicTrack,
} from "@/timeline/types";
import { getElementKeyframes } from "@/animation";
import * as model from "@/parallax-story-teller/model";
import { PARALLAX_CAMERA_KEYFRAME_PATHS } from "@/parallax-story-teller/camera-keyframes";

const TEMPLATE_IDS: model.ParallaxTemplateId[] = [
	"canvas-pan",
	"zoom-in-parallax",
	"zoom-out-parallax",
	"dolly-through",
	"world-canvas-tour",
	"speaker-on-world",
];

describe("Parallax Story Teller model", () => {
	test("builds a linked child scene and a renderable parent clip", () => {
		const setup = {
			direction: "right" as const,
			durationSeconds: 8,
			worldWidthFrames: 4,
		};
		const scene = model.buildCanvasPanScene({ parentSceneId: "parent", setup });
		const element = model.buildCanvasPanElement({
			sceneId: scene.id,
			startTime: ZERO_MEDIA_TIME,
			setup,
		});
		const linked = model.linkParallaxSceneToElement({
			scene,
			elementId: "story-element",
		});

		expect(model.readParallaxSceneId({ params: element.params })).toBe(
			scene.id,
		);
		expect(element.duration).toBe(mediaTimeFromSeconds({ seconds: 8 }));
		expect(linked.parallax).toMatchObject({
			parentSceneId: "parent",
			parentElementId: "story-element",
			direction: "right",
			worldWidthFrames: 4,
		});
		expect(scene.tracks.overlay[0]?.elements[0]?.params.kind).toBe(
			model.PARALLAX_CAMERA_GUIDE_KIND,
		);
		expect(
			scene.tracks.overlay.find((track) => track.type === "effect")?.hidden,
		).toBe(false);
		expect(scene.tracks.overlay[0]?.elements[0]?.params.specJson).toBeString();
		const cameraGuide = model.findParallaxCameraGuideElement({ scene });
		expect(
			getElementKeyframes({ animations: cameraGuide?.animations }),
		).toHaveLength(6);
	});

	test("keeps enough world space for a full-frame pan", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: {
				direction: "left",
				durationSeconds: 4,
				worldWidthFrames: 1,
			},
		});

		expect(scene.parallax?.worldWidthFrames).toBe(3);
	});

	test("does not impose a finite world-width ceiling", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: {
				direction: "right",
				durationSeconds: 4,
				worldWidthFrames: 24,
			},
		});

		expect(scene.parallax?.worldWidthFrames).toBe(24);
	});

	test("builds editable depth-plane groups for every populated preset", () => {
		for (const templateId of TEMPLATE_IDS) {
			const setup = {
				...model.getDefaultCanvasPanSetup(),
				templateId,
			};
			const scene = model.buildCanvasPanScene({
				parentSceneId: "parent",
				setup,
			});
			const markerTracks = scene.tracks.overlay.filter(
				(track) => track.type === "parallax",
			);
			const element = model.buildCanvasPanElement({
				sceneId: scene.id,
				startTime: ZERO_MEDIA_TIME,
				setup,
			});

			expect(markerTracks).toHaveLength(3);
			if (!markerTracks[0]) throw new Error("Expected a parallax marker track");
			const order = scene.tracks.order;
			if (!order) throw new Error("Expected explicit track order");
			expect(markerTracks.every((track) => track.speedPercent > 0)).toBeTrue();
			expect(order.indexOf(scene.tracks.main.id)).toBeLessThan(
				order.indexOf(markerTracks[0].id),
			);
			expect(element.params[model.PARALLAX_STORY_TYPE_PARAM]).toBe(templateId);
			const guide = model.findParallaxCameraGuideElement({ scene });
			const spec = JSON.parse(String(guide?.params.specJson));
			expect(spec.handheldAmount).toBe(0);
		}
	});

	test("keeps Blank empty, stationary and fully user-buildable", () => {
		const setup = {
			...model.getDefaultCanvasPanSetup(),
			templateId: "blank" as const,
			worldWidthFrames: 1,
		};
		const scene = model.buildCanvasPanScene({ parentSceneId: "parent", setup });
		const guide = model.findParallaxCameraGuideElement({ scene });

		expect(
			scene.tracks.overlay.filter((track) => track.type === "parallax"),
		).toHaveLength(0);
		expect(scene.parallax?.worldWidthFrames).toBe(1);
		expect(guide?.params.specJson).toBeString();
		expect(JSON.parse(String(guide?.params.specJson))).toMatchObject({
			cameraFromX: 0,
			cameraToX: 0,
			cameraFromScale: 1,
			cameraToScale: 1,
		});
	});

	test("materializes visible camera keyframes for existing canvas scenes", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: model.getDefaultCanvasPanSetup(),
		});
		const cameraGuide = model.findParallaxCameraGuideElement({ scene });
		if (!cameraGuide) throw new Error("Expected camera guide");
		cameraGuide.animations = undefined;

		const [restored] = model.restoreParallaxSceneMetadataForScenes({
			scenes: [scene],
		});
		if (!restored) throw new Error("Expected restored scene");
		const restoredGuide = model.findParallaxCameraGuideElement({
			scene: restored,
		});
		expect(
			getElementKeyframes({ animations: restoredGuide?.animations }),
		).toHaveLength(6);
	});

	test("removes legacy automatic camera sway from existing parallax scenes", () => {
		const setup = model.getDefaultCanvasPanSetup();
		const child = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup,
		});
		const guide = model.findParallaxCameraGuideElement({ scene: child });
		if (!guide) throw new Error("Expected camera guide");
		const legacySpec = {
			...JSON.parse(String(guide.params.specJson)),
			handheldAmount: 0.004,
		};
		guide.params = {
			...guide.params,
			specJson: JSON.stringify(legacySpec),
		};

		const parent = model.buildCanvasPanScene({
			parentSceneId: "story",
			setup,
		});
		const storyElement = {
			...model.buildCanvasPanElement({
				sceneId: child.id,
				startTime: ZERO_MEDIA_TIME,
				setup,
			}),
			id: "legacy-story-element",
			params: {
				...model.buildCanvasPanElement({
					sceneId: child.id,
					startTime: ZERO_MEDIA_TIME,
					setup,
				}).params,
				specJson: JSON.stringify(legacySpec),
			},
		} as EffectElement;
		const parentTrack = parent.tracks.overlay.find(
			(track): track is EffectTrack => track.type === "effect",
		);
		if (!parentTrack) throw new Error("Expected parent effect track");
		parentTrack.elements.push(storyElement);
		const linkedChild = model.linkParallaxSceneToElement({
			scene: child,
			elementId: storyElement.id,
		});

		const restored = model.restoreParallaxSceneMetadataForScenes({
			scenes: [parent, linkedChild],
		});
		const restoredParent = restored.find((scene) => scene.id === parent.id);
		const restoredChild = restored.find((scene) => scene.id === child.id);
		const restoredGuide = restoredChild
			? model.findParallaxCameraGuideElement({ scene: restoredChild })
			: null;
		const restoredStory = restoredParent?.tracks.overlay
			.filter((track): track is EffectTrack => track.type === "effect")
			.flatMap((track) => track.elements)
			.find((element) => element.id === storyElement.id);

		expect(
			JSON.parse(String(restoredGuide?.params.specJson)).handheldAmount,
		).toBe(0);
		expect(
			JSON.parse(String(restoredStory?.params.specJson)).handheldAmount,
		).toBe(0);
	});

	test("keeps the internal camera authoritative and removes duplicate parent camera channels", () => {
		const setup = model.getDefaultCanvasPanSetup();
		const parent = model.buildCanvasPanScene({
			parentSceneId: "story",
			setup,
		});
		const child = model.buildCanvasPanScene({
			parentSceneId: parent.id,
			setup,
		});
		const guide = model.findParallaxCameraGuideElement({ scene: child });
		if (!guide?.animations) throw new Error("Expected camera guide animations");
		const preservedPath = "params.unrelatedOpacity";
		const preservedChannel = guide.animations[PARALLAX_CAMERA_KEYFRAME_PATHS.x];
		const storyElement = {
			...model.buildCanvasPanElement({
				sceneId: child.id,
				startTime: ZERO_MEDIA_TIME,
				setup,
			}),
			id: "story-element",
			animations: {
				...guide.animations,
				[preservedPath]: preservedChannel,
			},
		} as EffectElement;
		const parentTrack = parent.tracks.overlay.find(
			(track): track is EffectTrack => track.type === "effect",
		);
		if (!parentTrack) throw new Error("Expected a parent effect track");
		parentTrack.elements.push(storyElement);
		const linkedChild = model.linkParallaxSceneToElement({
			scene: child,
			elementId: storyElement.id,
		});

		const restored = model.restoreParallaxSceneMetadataForScenes({
			scenes: [parent, linkedChild],
		});
		const restoredParent = restored.find((scene) => scene.id === parent.id);
		const restoredChild = restored.find((scene) => scene.id === child.id);
		if (!restoredParent || !restoredChild) {
			throw new Error("Expected restored parent and child scenes");
		}
		const restoredStory = restoredParent.tracks.overlay
			.filter((track): track is EffectTrack => track.type === "effect")
			.flatMap((track) => track.elements)
			.find((element) => element.id === storyElement.id);
		const restoredGuide = model.findParallaxCameraGuideElement({
			scene: restoredChild,
		});

		expect(restoredStory?.animations?.[preservedPath]).toEqual(
			preservedChannel,
		);
		for (const path of Object.values(PARALLAX_CAMERA_KEYFRAME_PATHS)) {
			expect(restoredStory?.animations?.[path]).toBeUndefined();
		}
		expect(restoredGuide?.animations).toEqual(guide.animations);
	});

	test("restores the preset camera route after an older Camera Man recording", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: model.getDefaultCanvasPanSetup(),
		});
		const guide = model.findParallaxCameraGuideElement({ scene });
		if (!guide) throw new Error("Expected camera guide");
		const cameraManAnimations = {
			...guide.animations,
			["params.parallax.cameraX"]: {
				keys: [
					{
						id: "bad-camera-man-key",
						time: ZERO_MEDIA_TIME,
						value: 999,
						segmentToNext: "bezier" as const,
						tangentMode: "auto" as const,
					},
				],
			},
		};

		const restored = model.getCameraAnimationsBeforeCameraMan({
			params: guide.params,
			duration: guide.duration,
			currentAnimations: cameraManAnimations,
		});
		const keyframes = getElementKeyframes({ animations: restored });

		expect(keyframes).toHaveLength(6);
		expect(keyframes.some((keyframe) => keyframe.value === 999)).toBeFalse();
	});

	test("restores the exact pre-recording camera animation backup when available", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: model.getDefaultCanvasPanSetup(),
		});
		const guide = model.findParallaxCameraGuideElement({ scene });
		if (!guide?.animations) throw new Error("Expected camera guide animations");
		const params = {
			...guide.params,
			[model.PARALLAX_CAMERA_MAN_BACKUP_PARAM]: JSON.stringify(
				guide.animations,
			),
		};

		const restored = model.getCameraAnimationsBeforeCameraMan({
			params,
			duration: guide.duration,
			currentAnimations: {},
		});

		expect(restored).toEqual(guide.animations);
	});

	test("restores metadata for legacy child scenes", () => {
		const setup = {
			direction: "left" as const,
			durationSeconds: 5,
			worldWidthFrames: 7,
		};
		const child = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup,
		});
		const parent = model.buildCanvasPanScene({
			parentSceneId: "story",
			setup,
		});
		const storyElement = model.buildCanvasPanElement({
			sceneId: child.id,
			startTime: ZERO_MEDIA_TIME,
			setup,
		});
		const parentTrack = parent.tracks.overlay.find(
			(track): track is EffectTrack => track.type === "effect",
		);
		if (!parentTrack) throw new Error("Expected a parent effect track");
		parentTrack.elements.push({
			...storyElement,
			id: "story-element",
		} as EffectElement);

		const legacyChild = { ...child, parallax: undefined };
		const restored = model.restoreParallaxSceneMetadata({
			scene: legacyChild,
			scenes: [parent, legacyChild],
		});

		expect(restored.parallax).toMatchObject({
			parentSceneId: parent.id,
			parentElementId: "story-element",
			direction: "left",
			worldWidthFrames: 7,
		});
	});

	test("normalizes legacy world backgrounds without stretching ordinary graphics", () => {
		const scene = model.buildCanvasPanScene({
			parentSceneId: "parent",
			setup: {
				...model.getDefaultCanvasPanSetup(),
				worldWidthFrames: 7,
				worldHeightFrames: 1,
			},
		});
		const duration = mediaTimeFromSeconds({ seconds: 6 });
		const legacyBackground: GraphicElement = {
			id: "legacy-world-grid",
			name: "Grid",
			type: "graphic",
			definitionId: "preset-background",
			startTime: ZERO_MEDIA_TIME,
			duration,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: {
				"layout.width": 12_226,
				"layout.height": 12_226,
				"transform.positionX": 0,
				"transform.positionY": 0,
				"transform.scaleX": 3,
				"transform.scaleY": 3,
			},
		};
		const ordinaryBackground: GraphicElement = {
			...legacyBackground,
			id: "ordinary-grid",
			params: {
				...legacyBackground.params,
				"layout.width": 1080,
				"layout.height": 1920,
			},
		};
		const graphicTrack: GraphicTrack = {
			id: "graphic-track",
			name: "Backgrounds",
			type: "graphic",
			hidden: false,
			elements: [legacyBackground, ordinaryBackground],
		};
		scene.tracks.overlay.push(graphicTrack);

		const [restored] = model.restoreParallaxSceneMetadataForScenes({
			scenes: [scene],
			cameraCanvasSize: { width: 1080, height: 1920 },
		});
		const restoredTrack = restored?.tracks.overlay.find(
			(track): track is GraphicTrack => track.id === graphicTrack.id,
		);
		const restoredLegacy = restoredTrack?.elements.find(
			(element) => element.id === legacyBackground.id,
		);
		const restoredOrdinary = restoredTrack?.elements.find(
			(element) => element.id === ordinaryBackground.id,
		);

		expect(restoredLegacy?.params).toMatchObject({
			"layout.width": 7560,
			"layout.height": 1920,
			"transform.positionX": 3240,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
		});
		expect(restoredOrdinary?.params).toEqual(ordinaryBackground.params);
	});
});
