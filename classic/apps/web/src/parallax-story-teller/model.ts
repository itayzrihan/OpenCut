import { CUSTOM_AI_EFFECT_TYPE } from "@/effects/custom-ai-effect";
import {
	OVERLAY_MOVEMENT_PRESETS,
	resolveOverlayMovementCameraState,
} from "@/effects/overlay-movement-presets";
import { hasKeyframesForPath } from "@/animation";
import type { ChannelData, ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import type { TCanvasSize } from "@/project/types";
import type {
	CreateEffectElement,
	EffectElement,
	EffectTrack,
	ParallaxTrack,
	TimelineElement,
	TScene,
	VideoTrack,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import { cameraManSamplesToAnimations } from "./camera-man";
import { PARALLAX_CAMERA_KEYFRAME_PATHS } from "./camera-keyframes";

export const PARALLAX_STORY_KIND = "parallax-story-teller";
export const PARALLAX_CANVAS_PAN_TYPE = "canvas-pan";
export const PARALLAX_SCENE_ID_PARAM = "parallax.sceneId";
export const PARALLAX_STORY_TYPE_PARAM = "parallax.storyType";
export const PARALLAX_WORLD_WIDTH_PARAM = "parallax.worldWidthFrames";
export const PARALLAX_DIRECTION_PARAM = "parallax.direction";
export const PARALLAX_CAMERA_GUIDE_KIND = "parallax-camera-guide";
export const PARALLAX_CAMERA_MAN_BACKUP_PARAM = "parallax.cameraManBackup";

const DEFAULT_WORLD_WIDTH_FRAMES = 3;
const DEFAULT_DURATION_SECONDS = 6;

const LEGACY_PARALLAX_HANDHELD_DEFAULTS: Record<string, number> = {
	"camera-canvas-pan-right": 0.004,
	"camera-canvas-pan-left": 0.004,
	"camera-parallax-scroll": 0.005,
	"camera-dolly-through": 0.0045,
	"camera-zoom-out-parallax": 0.0045,
	"camera-world-canvas-tour": 0.0035,
};

function parseRecordJson({
	raw,
}: {
	raw: string;
}): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? Object.fromEntries(Object.entries(parsed))
			: null;
	} catch {
		return null;
	}
}

function withoutAutomaticParallaxCameraSway({
	params,
	force = false,
}: {
	params: ParamValues;
	force?: boolean;
}): ParamValues {
	const rawSpec = params.specJson;
	if (typeof rawSpec !== "string") return params;
	const spec = parseRecordJson({ raw: rawSpec });
	if (!spec || typeof spec.presetId !== "string") return params;
	const handheldAmount = spec.handheldAmount;
	if (typeof handheldAmount !== "number" || handheldAmount === 0) return params;
	const legacyDefault = LEGACY_PARALLAX_HANDHELD_DEFAULTS[spec.presetId];
	if (
		!force &&
		(typeof legacyDefault !== "number" ||
			Math.abs(handheldAmount - legacyDefault) > Number.EPSILON)
	) {
		return params;
	}

	return {
		...params,
		specJson: JSON.stringify(
			{
				...spec,
				handheldAmount: 0,
			},
			null,
			2,
		),
	};
}

function isAnimationChannelData(value: unknown): value is ChannelData {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	if ("keys" in value) return Array.isArray(value.keys);
	return Object.values(value).every(
		(channel) => channel === undefined || isAnimationChannelData(channel),
	);
}

function parseElementAnimations({
	raw,
}: {
	raw: string;
}): ElementAnimations | null {
	const parsed = parseRecordJson({ raw });
	if (!parsed) return null;
	const animations: ElementAnimations = {};
	for (const [propertyPath, channel] of Object.entries(parsed)) {
		if (channel !== undefined && !isAnimationChannelData(channel)) return null;
		animations[propertyPath] = channel;
	}
	return animations;
}

function materializeCameraKeyframes({
	params,
	duration,
	baseAnimations,
}: {
	params: ParamValues;
	duration: MediaTime;
	baseAnimations?: ElementAnimations;
}): ElementAnimations {
	const hasCameraKeyframes = Object.values(PARALLAX_CAMERA_KEYFRAME_PATHS).some(
		(propertyPath) =>
			hasKeyframesForPath({ animations: baseAnimations, propertyPath }),
	);
	if (hasCameraKeyframes) return baseAnimations ?? {};

	const start = resolveOverlayMovementCameraState({
		effectParams: params,
		animations: baseAnimations,
		localTime: ZERO_MEDIA_TIME,
		duration,
	});
	const end = resolveOverlayMovementCameraState({
		effectParams: params,
		animations: baseAnimations,
		localTime: duration,
		duration,
	});
	return cameraManSamplesToAnimations({
		baseAnimations,
		samples: [
			{ time: ZERO_MEDIA_TIME, ...start },
			{ time: duration, ...end },
		],
	});
}

function withoutCameraKeyframes({
	animations,
}: {
	animations?: ElementAnimations;
}): ElementAnimations {
	const cameraPaths = new Set<string>(
		Object.values(PARALLAX_CAMERA_KEYFRAME_PATHS),
	);
	const preserved: ElementAnimations = {};
	for (const [propertyPath, channel] of Object.entries(animations ?? {})) {
		if (!cameraPaths.has(propertyPath)) {
			preserved[propertyPath] = channel;
		}
	}
	return preserved;
}

function removeParentCameraAnimationsFromScene({
	scene,
}: {
	scene: TScene;
}): TScene {
	const cameraPaths = Object.values(PARALLAX_CAMERA_KEYFRAME_PATHS);
	let sceneChanged = false;

	const normalizeTrack = <
		TTrack extends { elements: TimelineElement[] },
	>(
		track: TTrack,
	): TTrack => {
		let trackChanged = false;
		const elements = track.elements.map((element) => {
			if (
				element.type !== "effect" ||
				!readParallaxSceneId({ params: element.params }) ||
				!element.animations ||
				!cameraPaths.some((path) =>
					Object.prototype.hasOwnProperty.call(element.animations, path),
				)
			) {
				return element;
			}

			trackChanged = true;
			const animations = withoutCameraKeyframes({
				animations: element.animations,
			});
			return {
				...element,
				animations:
					Object.keys(animations).length > 0 ? animations : undefined,
			};
		});

		if (!trackChanged) return track;
		sceneChanged = true;
		return { ...track, elements } as TTrack;
	};

	const main = normalizeTrack(scene.tracks.main);
	const overlay = scene.tracks.overlay.map(normalizeTrack);
	if (!sceneChanged) return scene;

	return {
		...scene,
		tracks: { ...scene.tracks, main, overlay },
		updatedAt: new Date(),
	};
}

function removeLegacyAutomaticParallaxSwayFromScene({
	scene,
}: {
	scene: TScene;
}): TScene {
	let sceneChanged = false;
	const normalizeTrack = <
		TTrack extends { elements: TimelineElement[] },
	>(
		track: TTrack,
	): TTrack => {
		let trackChanged = false;
		const elements = track.elements.map((element) => {
			if (
				element.type !== "effect" ||
				(!isParallaxCameraGuideElement(element) &&
					!readParallaxSceneId({ params: element.params }))
			) {
				return element;
			}
			const params = withoutAutomaticParallaxCameraSway({
				params: element.params,
			});
			if (params === element.params) return element;
			trackChanged = true;
			return { ...element, params };
		});

		if (!trackChanged) return track;
		sceneChanged = true;
		return { ...track, elements } as TTrack;
	};

	const main = normalizeTrack(scene.tracks.main);
	const overlay = scene.tracks.overlay.map(normalizeTrack);
	if (!sceneChanged) return scene;
	return {
		...scene,
		tracks: { ...scene.tracks, main, overlay },
		updatedAt: new Date(),
	};
}

function normalizeLegacyParallaxWorldBackgrounds({
	scene,
	cameraCanvasSize,
}: {
	scene: TScene;
	cameraCanvasSize: TCanvasSize;
}): TScene {
	if (!scene.parallax) return scene;
	const worldWidth =
		cameraCanvasSize.width * Math.max(1, scene.parallax.worldWidthFrames);
	const worldHeight =
		cameraCanvasSize.height * Math.max(1, scene.parallax.worldHeightFrames ?? 1);
	const expectedPositionX = (worldWidth - cameraCanvasSize.width) / 2;
	const expectedPositionY = (worldHeight - cameraCanvasSize.height) / 2;
	let sceneChanged = false;

	const normalizeTrack = <
		TTrack extends { elements: TimelineElement[] },
	>(
		track: TTrack,
	): TTrack => {
		let trackChanged = false;
		const elements = track.elements.map((element) => {
			if (
				element.type !== "graphic" ||
				element.definitionId !== "preset-background"
			) {
				return element;
			}

			const layoutWidth = element.params["layout.width"];
			const layoutHeight = element.params["layout.height"];
			const positionX = element.params["transform.positionX"];
			const positionY = element.params["transform.positionY"];
			const isLegacyWorldCover =
				typeof layoutWidth === "number" &&
				typeof layoutHeight === "number" &&
				layoutWidth >= worldWidth * 0.8 &&
				layoutHeight >= worldHeight * 0.8 &&
				(typeof positionX !== "number" || Math.abs(positionX) < 1) &&
				(typeof positionY !== "number" || Math.abs(positionY) < 1);
			if (!isLegacyWorldCover) return element;

			trackChanged = true;
			return {
				...element,
				params: {
					...element.params,
					"layout.width": worldWidth,
					"layout.height": worldHeight,
					"transform.positionX": expectedPositionX,
					"transform.positionY": expectedPositionY,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
				},
			};
		});

		if (!trackChanged) return track;
		sceneChanged = true;
		return { ...track, elements } as TTrack;
	};

	const main = normalizeTrack(scene.tracks.main);
	const overlay = scene.tracks.overlay.map(normalizeTrack);
	if (!sceneChanged) return scene;

	return {
		...scene,
		tracks: { ...scene.tracks, main, overlay },
		updatedAt: new Date(),
	};
}

/**
 * Rebuilds only the three camera channels from the template route. Other
 * animation channels remain untouched, so recovering from Camera Man cannot
 * damage unrelated animation authored on the guide element.
 */
export function buildPresetCameraAnimations({
	params,
	duration,
	baseAnimations,
}: {
	params: ParamValues;
	duration: MediaTime;
	baseAnimations?: ElementAnimations;
}): ElementAnimations {
	const preservedAnimations = withoutCameraKeyframes({
		animations: baseAnimations,
	});
	const start = resolveOverlayMovementCameraState({
		effectParams: params,
		animations: preservedAnimations,
		localTime: ZERO_MEDIA_TIME,
		duration,
	});
	const end = resolveOverlayMovementCameraState({
		effectParams: params,
		animations: preservedAnimations,
		localTime: duration,
		duration,
	});
	return cameraManSamplesToAnimations({
		baseAnimations: preservedAnimations,
		samples: [
			{ time: ZERO_MEDIA_TIME, ...start },
			{ time: duration, ...end },
		],
	});
}

export function getCameraAnimationsBeforeCameraMan({
	params,
	duration,
	currentAnimations,
}: {
	params: ParamValues;
	duration: MediaTime;
	currentAnimations?: ElementAnimations;
}): ElementAnimations {
	const rawBackup = params[PARALLAX_CAMERA_MAN_BACKUP_PARAM];
	if (typeof rawBackup === "string" && rawBackup.length > 0) {
		const parsed = parseElementAnimations({ raw: rawBackup });
		if (parsed) return parsed;
	}

	return buildPresetCameraAnimations({
		params,
		duration,
		baseAnimations: currentAnimations,
	});
}

function findSceneElement({
	scene,
	elementId,
}: {
	scene: TScene;
	elementId: string;
}): TimelineElement | null {
	const tracks = [scene.tracks.main, ...scene.tracks.overlay];
	for (const track of tracks) {
		const element = track.elements.find(
			(candidate) => candidate.id === elementId,
		);
		if (element) return element;
	}
	return null;
}

function findElementTrackId({
	scene,
	elementId,
}: {
	scene: TScene;
	elementId: string;
}): string | null {
	const tracks = [scene.tracks.main, ...scene.tracks.overlay];
	return (
		tracks.find((track) =>
			track.elements.some((element) => element.id === elementId),
		)?.id ?? null
	);
}

function replaceSceneElement({
	scene,
	element,
	trackId,
}: {
	scene: TScene;
	element: TimelineElement;
	trackId: string | null;
}): TScene {
	if (!trackId) return scene;
	const replaceTrack = <
		TTrack extends { id: string; elements: TimelineElement[] },
	>(
		track: TTrack,
	): TTrack => {
		const nextTrack = {
			...track,
			elements: track.elements.map((candidate) =>
				candidate.id === element.id ? element : candidate,
			),
		};
		return (
			"hidden" in nextTrack ? { ...nextTrack, hidden: false } : nextTrack
		) as TTrack;
	};

	return {
		...scene,
		tracks: {
			...scene.tracks,
			main:
				scene.tracks.main.id === trackId
					? replaceTrack(scene.tracks.main)
					: scene.tracks.main,
			overlay: scene.tracks.overlay.map((track) =>
				track.id === trackId ? replaceTrack(track) : track,
			),
		},
		updatedAt: new Date(),
	};
}

export function findParallaxCameraGuideElement({
	scene,
}: {
	scene: TScene;
}): EffectElement | null {
	const tracks = [scene.tracks.main, ...scene.tracks.overlay];
	for (const track of tracks) {
		const guide = track.elements.find(
			(element): element is EffectElement =>
				element.type === "effect" &&
				element.params.kind === PARALLAX_CAMERA_GUIDE_KIND,
		);
		if (guide) return guide;
	}
	return null;
}

export function isParallaxCameraGuideElement(element: EffectElement): boolean {
	return element.params.kind === PARALLAX_CAMERA_GUIDE_KIND;
}

function buildCanvasPanCameraParams({
	setup,
}: {
	setup: CanvasPanSetup;
}): ParamValues {
	const templateId = setup.templateId ?? "canvas-pan";
	const presetId =
		templateId === "dolly-through" ||
		templateId === "zoom-in-parallax" ||
		templateId === "zoom-out-parallax"
			? "camera-dolly-through"
			: templateId === "world-canvas-tour"
				? "camera-world-canvas-tour"
				: templateId === "speaker-on-world"
					? "camera-parallax-scroll"
					: setup.direction === "left"
						? "camera-canvas-pan-left"
						: "camera-canvas-pan-right";
	const preset = OVERLAY_MOVEMENT_PRESETS.find((item) => item.id === presetId);
	let presetParams = preset?.params ?? {};
	if (templateId === "zoom-out-parallax") {
		const rawSpec = presetParams.specJson;
		if (typeof rawSpec === "string") {
			const spec = parseRecordJson({ raw: rawSpec });
			if (spec) {
				presetParams = {
					...presetParams,
					specJson: JSON.stringify(
						{
							...spec,
							presetId: "camera-zoom-out-parallax",
							cameraFromScale: 2.1,
							cameraToScale: 0.72,
							cameraFromX: 0.12,
							cameraToX: -0.08,
						},
						null,
						2,
					),
				};
			}
		}
	}
	if (templateId === "blank") {
		const rawSpec = presetParams.specJson;
		if (typeof rawSpec === "string") {
			const spec = parseRecordJson({ raw: rawSpec });
			if (spec) {
				presetParams = {
					...presetParams,
					specJson: JSON.stringify(
						{
							...spec,
							presetId: "camera-blank-parallax",
							cameraFromX: 0,
							cameraFromY: 0,
							cameraToX: 0,
							cameraToY: 0,
							cameraFromScale: 1,
							cameraToScale: 1,
							parallaxStrength: 0,
							handheldAmount: 0,
						},
						null,
						2,
					),
				};
			}
		}
	}
	presetParams = withoutAutomaticParallaxCameraSway({
		params: presetParams,
		force: true,
	});
	const templateName = PARALLAX_TEMPLATE_NAMES[templateId];
	return {
		...presetParams,
		kind: PARALLAX_CAMERA_GUIDE_KIND,
		label: `${templateName} Camera`,
		intent: "Camera movement for the parallax canvas. The world stays static.",
		[PARALLAX_DIRECTION_PARAM]: setup.direction,
		[PARALLAX_WORLD_WIDTH_PARAM]: setup.worldWidthFrames,
	};
}

function readLegacyCanvasPanMetadata({
	scene,
	scenes,
}: {
	scene: TScene;
	scenes: TScene[];
}): TScene["parallax"] | null {
	if (scene.parallax) return scene.parallax;

	for (const parentScene of scenes) {
		if (parentScene.id === scene.id) continue;

		const tracks = [parentScene.tracks.main, ...parentScene.tracks.overlay];
		for (const track of tracks) {
			const parentElement = track.elements.find(
				(element): element is EffectElement =>
					element.type === "effect" &&
					readParallaxSceneId({ params: element.params }) === scene.id,
			);

			if (!parentElement) continue;

			const rawDirection = parentElement.params[PARALLAX_DIRECTION_PARAM];
			const rawWorldWidth = parentElement.params[PARALLAX_WORLD_WIDTH_PARAM];
			const worldWidthFrames =
				typeof rawWorldWidth === "number" && Number.isFinite(rawWorldWidth)
					? Math.max(DEFAULT_WORLD_WIDTH_FRAMES, rawWorldWidth)
					: DEFAULT_WORLD_WIDTH_FRAMES;

			return {
				version: 1,
				kind: PARALLAX_CANVAS_PAN_TYPE,
				parentSceneId: parentScene.id,
				parentElementId: parentElement.id,
				direction: rawDirection === "left" ? "left" : "right",
				worldWidthFrames,
			};
		}
	}

	return null;
}

/**
 * Older projects persisted the child scene but not its parallax metadata.
 * Recover it from the parent story element so those scenes reopen in the
 * dedicated canvas editor instead of falling back to the regular scene UI.
 */
export function restoreParallaxSceneMetadata({
	scene,
	scenes,
}: {
	scene: TScene;
	scenes: TScene[];
}): TScene {
	const parallax = readLegacyCanvasPanMetadata({ scene, scenes });
	if (!parallax || scene.parallax) return scene;

	return { ...scene, parallax };
}

export function restoreParallaxSceneMetadataForScenes({
	scenes,
	cameraCanvasSize,
}: {
	scenes: TScene[];
	cameraCanvasSize?: TCanvasSize;
}): TScene[] {
	const normalizedScenes = scenes.map((scene) =>
		restoreParallaxSceneMetadata({ scene, scenes }),
	);

	const scenesWithInternalCameras = normalizedScenes.map((scene) => {
		if (!scene.parallax) return scene;

		const guide = findParallaxCameraGuideElement({ scene });
		if (!guide) return scene;

		let nextParams = guide.params;
		let nextAnimations = guide.animations;
		if (typeof guide.params.specJson !== "string") {
			const parentScene = normalizedScenes.find(
				(candidate) => candidate.id === scene.parallax?.parentSceneId,
			);
			const parentElement = parentScene
				? findSceneElement({
						scene: parentScene,
						elementId: scene.parallax.parentElementId,
					})
				: null;
			if (!parentElement || parentElement.type !== "effect") return scene;
			nextParams = {
				...parentElement.params,
				kind: PARALLAX_CAMERA_GUIDE_KIND,
				label: "Canvas Pan Camera",
				intent:
					"Camera movement for the parallax canvas. The world stays static.",
			};
			nextAnimations = guide.animations ?? parentElement.animations;
		}

		const materializedAnimations = materializeCameraKeyframes({
			params: nextParams,
			duration: guide.duration,
			baseAnimations: nextAnimations,
		});
		if (
			nextParams === guide.params &&
			materializedAnimations === guide.animations
		) {
			return scene;
		}
		const nextGuide = {
			...guide,
			params: nextParams,
			animations: materializedAnimations,
		};
		return replaceSceneElement({
			scene,
			element: nextGuide,
			trackId: findElementTrackId({ scene, elementId: guide.id }),
		});
	});

	// The nested Camera layer is the single source of truth. Older builds also
	// allowed camera keyframes on the outer story clip, which could override the
	// internal camera and make the main scene disagree with the canvas editor.
	const scenesWithoutParentCameras = scenesWithInternalCameras.map((scene) =>
		removeLegacyAutomaticParallaxSwayFromScene({
			scene: removeParentCameraAnimationsFromScene({ scene }),
		}),
	);
	if (!cameraCanvasSize) return scenesWithoutParentCameras;

	return scenesWithoutParentCameras.map((scene) =>
		normalizeLegacyParallaxWorldBackgrounds({
			scene,
			cameraCanvasSize,
		}),
	);
}

export interface CanvasPanSetup {
	direction: "left" | "right";
	durationSeconds: number;
	worldWidthFrames: number;
	worldHeightFrames?: number;
	templateId?: ParallaxTemplateId;
}

export type ParallaxTemplateId =
	| "blank"
	| "canvas-pan"
	| "zoom-in-parallax"
	| "zoom-out-parallax"
	| "dolly-through"
	| "world-canvas-tour"
	| "speaker-on-world";

const PARALLAX_TEMPLATE_NAMES: Record<ParallaxTemplateId, string> = {
	blank: "Blank",
	"canvas-pan": "Canvas Pan",
	"zoom-in-parallax": "Zoom In Parallax",
	"zoom-out-parallax": "Zoom Out Parallax",
	"dolly-through": "Dolly Through",
	"world-canvas-tour": "World Canvas Tour",
	"speaker-on-world": "Speaker on World",
};

export function getDefaultCanvasPanSetup(): CanvasPanSetup {
	return {
		direction: "right",
		durationSeconds: DEFAULT_DURATION_SECONDS,
		worldWidthFrames: DEFAULT_WORLD_WIDTH_FRAMES,
		worldHeightFrames: 1,
	};
}

function getTemplatePlaneSpecs({
	templateId,
}: {
	templateId: ParallaxTemplateId;
}): Array<{
	name: string;
	direction: ParallaxTrack["direction"];
	speedPercent: number;
}> {
	switch (templateId) {
		case "blank":
			return [];
		case "canvas-pan":
			return [
				{ name: "Foreground", direction: "with-camera", speedPercent: 85 },
				{ name: "Midground", direction: "against-camera", speedPercent: 45 },
				{ name: "Background", direction: "against-camera", speedPercent: 18 },
			];
		case "zoom-in-parallax":
		case "dolly-through":
			return [
				{
					name: "Near foreground",
					direction: "with-camera",
					speedPercent: 150,
				},
				{
					name: "Subject plane",
					direction: "against-camera",
					speedPercent: 65,
				},
				{
					name: "Deep background",
					direction: "against-camera",
					speedPercent: 15,
				},
			];
		case "zoom-out-parallax":
			return [
				{
					name: "Reveal foreground",
					direction: "with-camera",
					speedPercent: 120,
				},
				{ name: "World plane", direction: "against-camera", speedPercent: 42 },
				{ name: "Horizon", direction: "against-camera", speedPercent: 12 },
			];
		case "world-canvas-tour":
			return [
				{ name: "Tour foreground", direction: "with-camera", speedPercent: 95 },
				{ name: "Stations", direction: "against-camera", speedPercent: 50 },
				{
					name: "Map background",
					direction: "against-camera",
					speedPercent: 20,
				},
			];
		case "speaker-on-world":
			return [
				{
					name: "Speaker foreground",
					direction: "with-camera",
					speedPercent: 110,
				},
				{
					name: "World graphics",
					direction: "against-camera",
					speedPercent: 38,
				},
				{
					name: "World background",
					direction: "against-camera",
					speedPercent: 14,
				},
			];
	}
}

function buildTemplatePlaneTracks({
	templateId,
}: {
	templateId: ParallaxTemplateId;
}): { overlay: Array<ParallaxTrack | VideoTrack>; order: string[] } {
	const overlay: Array<ParallaxTrack | VideoTrack> = [];
	const order: string[] = [];
	for (const plane of getTemplatePlaneSpecs({ templateId })) {
		const marker: ParallaxTrack = {
			id: generateUUID(),
			name: `${plane.name} parallax`,
			type: "parallax",
			elements: [],
			direction: plane.direction,
			speedPercent: plane.speedPercent,
		};
		const contentTrack: VideoTrack = {
			id: generateUUID(),
			name: plane.name,
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		};
		overlay.push(marker, contentTrack);
		order.push(marker.id, contentTrack.id);
	}
	return { overlay, order };
}

export function buildCanvasPanScene({
	parentSceneId,
	setup,
}: {
	parentSceneId: string;
	setup: CanvasPanSetup;
}): TScene {
	const sceneId = generateUUID();
	const mainTrackId = generateUUID();
	const duration = mediaTimeFromSeconds({
		seconds: Math.max(0.5, setup.durationSeconds),
	});
	const guideTrack: EffectTrack = {
		id: generateUUID(),
		type: "effect",
		name: "Camera",
		hidden: false,
		elements: [],
	};
	const templateId = setup.templateId ?? "canvas-pan";
	const templateName = PARALLAX_TEMPLATE_NAMES[templateId];
	const templatePlanes = buildTemplatePlaneTracks({ templateId });
	const cameraParams = buildCanvasPanCameraParams({ setup });
	guideTrack.elements.push({
		id: generateUUID(),
		name: "Camera Movement",
		type: "effect",
		effectType: CUSTOM_AI_EFFECT_TYPE,
		startTime: ZERO_MEDIA_TIME,
		duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: cameraParams,
		animations: materializeCameraKeyframes({
			params: cameraParams,
			duration,
		}),
	});

	return {
		id: sceneId,
		name: `${templateName} World`,
		isMain: false,
		parallax: {
			version: 1,
			kind: PARALLAX_CANVAS_PAN_TYPE,
			parentSceneId,
			parentElementId: "",
			direction: setup.direction,
			worldWidthFrames: Math.max(
				templateId === "blank" ? 1 : 3,
				setup.worldWidthFrames,
			),
			worldHeightFrames: Math.max(1, setup.worldHeightFrames ?? 1),
			templateId,
		},
		tracks: {
			overlay: [guideTrack, ...templatePlanes.overlay],
			main: {
				id: mainTrackId,
				name: "Main",
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
			audio: [],
			order: [guideTrack.id, mainTrackId, ...templatePlanes.order],
		},
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

export function buildCanvasPanElement({
	sceneId,
	startTime,
	setup,
}: {
	sceneId: string;
	startTime: MediaTime;
	setup: CanvasPanSetup;
}): CreateEffectElement {
	const templateId = setup.templateId ?? "canvas-pan";
	const templateName = PARALLAX_TEMPLATE_NAMES[templateId];
	const duration = mediaTimeFromSeconds({
		seconds: Math.max(0.5, setup.durationSeconds),
	});
	return {
		type: "effect",
		effectType: CUSTOM_AI_EFFECT_TYPE,
		name: `Parallax · ${templateName}`,
		startTime,
		duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			...buildCanvasPanCameraParams({ setup }),
			kind: PARALLAX_STORY_KIND,
			[PARALLAX_STORY_TYPE_PARAM]: templateId,
			[PARALLAX_SCENE_ID_PARAM]: sceneId,
			[PARALLAX_DIRECTION_PARAM]: setup.direction,
			[PARALLAX_WORLD_WIDTH_PARAM]: setup.worldWidthFrames,
		},
	};
}

export function readParallaxSceneId({
	params,
}: {
	params: ParamValues | Record<string, unknown>;
}): string | null {
	if (params.kind !== PARALLAX_STORY_KIND) return null;
	const sceneId = params[PARALLAX_SCENE_ID_PARAM];
	return typeof sceneId === "string" && sceneId.length > 0 ? sceneId : null;
}

export function isParallaxStoryElement(element: EffectElement): boolean {
	return readParallaxSceneId({ params: element.params }) !== null;
}

export function linkParallaxSceneToElement({
	scene,
	elementId,
}: {
	scene: TScene;
	elementId: string;
}): TScene {
	if (!scene.parallax) return scene;
	return {
		...scene,
		parallax: { ...scene.parallax, parentElementId: elementId },
		updatedAt: new Date(),
	};
}
