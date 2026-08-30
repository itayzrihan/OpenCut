import type { SceneTracks, TimelineTrack, TScene } from "@/timeline";
import { calculateTotalDuration, getDisplayTracks } from "@/timeline";
import type { ElementAnimations } from "@/animation/types";
import type { MediaAsset } from "@/media/types";
import { resolveUnifiedAnglesVideoAsset } from "@/media/unified-angles";
import type { ParamValues } from "@/params";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { SpeakerFrameBreakoutNode } from "./nodes/speaker-frame-breakout-node";
import { PersonCutoutLayerNode } from "./nodes/person-cutout-layer-node";
import { ParallaxSceneNode } from "./nodes/parallax-scene-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { buildTransitionAnimationsFromElement } from "@/transitions";
import { readCameraLayerSettings } from "@/effects/virtual-camera";
import {
	buildSpeakerFrameSourceSignature,
	buildSpeakerFrameLegacySourceSignatures,
	getSpeakerFrameSourceBindings,
	isSpeakerFrameBreakoutAppliedAndCurrent,
	isSpeakerFrameBreakoutElement,
	readSpeakerFrameBreakoutFade,
	readSpeakerFrameBreakoutSettings,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import {
	buildPersonCutoutLayerSourceSignature,
	buildPersonCutoutLayerLegacySourceSignatures,
	isPersonCutoutLayerAppliedAndCurrent,
	isPersonCutoutLayerElement,
	readPersonCutoutLayerFade,
	readPersonCutoutLayerSettings,
} from "@/simple-advanced-layers/person-cutout-layer";
import {
	findParallaxCameraGuideElement,
	isParallaxCameraGuideElement,
	readParallaxSceneId,
} from "@/parallax-story-teller/model";
import { CUSTOM_AI_EFFECT_TYPE } from "@/effects/custom-ai-effect";
import {
	getParallaxWorldMotionFactor,
	resolveParallaxTrackAssignments,
} from "@/parallax-story-teller/parallax-tracks";

const PREVIEW_MAX_IMAGE_SIZE = 1920;
export const PREVIEW_MAX_VIDEO_SIZE = 1280;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildTrackNodes({
	tracks,
	sceneTracks,
	mediaMap,
	mediaAssets,
	canvasSize,
	cameraCanvasSize,
	isPreview,
	scenes,
	visitedSceneIds,
	isParallaxCanvasScene,
}: {
	tracks: TimelineTrack[];
	sceneTracks: SceneTracks;
	mediaMap: Map<string, MediaAsset>;
	mediaAssets: MediaAsset[];
	canvasSize: TCanvasSize;
	cameraCanvasSize: TCanvasSize;
	isPreview?: boolean;
	scenes: TScene[];
	visitedSceneIds: ReadonlySet<string>;
	isParallaxCanvasScene: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];
	const parallaxAssignments = isParallaxCanvasScene
		? resolveParallaxTrackAssignments({
				tracks: getDisplayTracks({ tracks: sceneTracks }),
			})
		: new Map();

	for (const track of tracks) {
		if (track.type === "parallax") continue;
		const parallaxAssignment = parallaxAssignments.get(track.id);
		const elements = getVisibleSortedElements({ track });

		for (const element of elements) {
			if (element.type === "effect") {
				const nestedSceneId = readParallaxSceneId({ params: element.params });
				if (nestedSceneId && !visitedSceneIds.has(nestedSceneId)) {
					const nestedScene = scenes.find(
						(scene) => scene.id === nestedSceneId,
					);
					if (nestedScene) {
						const cameraGuide = findParallaxCameraGuideElement({
							scene: nestedScene,
						});
						const hasInternalCamera =
							cameraGuide && typeof cameraGuide.params.specJson === "string";
						const cameraParams = hasInternalCamera
							? cameraGuide.params
							: element.params;
						const sourceDuration = Math.max(
							1,
							calculateTotalDuration({ tracks: nestedScene.tracks }),
						);
						const nestedNode = new ParallaxSceneNode({
							timeOffset: element.startTime,
							duration: element.duration,
							sourceDuration,
							effectParams: cameraParams,
							storyParams: element.params,
							effectAnimations: hasInternalCamera
								? cameraGuide.animations
								: element.animations,
							cameraWidth: cameraCanvasSize.width,
							cameraHeight: cameraCanvasSize.height,
							cameraDuration: hasInternalCamera
								? cameraGuide.duration
								: element.duration,
							cameraTimeOffset: hasInternalCamera ? cameraGuide.startTime : 0,
							cameraUsesSourceTime: Boolean(hasInternalCamera),
							worldWidthFrames: nestedScene.parallax?.worldWidthFrames ?? 1,
							worldHeightFrames: nestedScene.parallax?.worldHeightFrames ?? 1,
						});
						const nestedTracks = getDisplayTracks({
							tracks: nestedScene.tracks,
						})
							.filter(
								(nestedTrack) =>
									!("hidden" in nestedTrack && nestedTrack.hidden) &&
									nestedTrack.type !== "audio",
							)
							.slice()
							.reverse();
						const nextVisited = new Set(visitedSceneIds);
						nextVisited.add(nestedSceneId);
						for (const child of buildTrackNodes({
							tracks: nestedTracks,
							sceneTracks: nestedScene.tracks,
							mediaMap,
							mediaAssets,
							canvasSize,
							cameraCanvasSize,
							isPreview,
							scenes,
							visitedSceneIds: nextVisited,
							isParallaxCanvasScene: Boolean(nestedScene.parallax),
						})) {
							nestedNode.add(child);
						}
						nodes.push(nestedNode);
					}
					continue;
				}
				if (isParallaxCameraGuideElement(element)) {
					// The guide is a camera control layer, not a visual effect. Its
					// movement is applied by the parent parallax scene only.
					continue;
				}
				if (isSpeakerFrameBreakoutElement(element)) {
					const storedSettings = readSpeakerFrameBreakoutSettings({
						params: element.params,
					});
					const fade = readSpeakerFrameBreakoutFade({ element });
					const settings = {
						...storedSettings,
						...fade,
					};
					const bindings = getSpeakerFrameSourceBindings({
						tracks: sceneTracks,
						smartTrackId: track.id,
						layer: element,
					});
					const sourceSignature = buildSpeakerFrameSourceSignature({
						layer: element,
						bindings,
						mediaAssets,
						settings,
					});
					const legacySourceSignatures =
						buildSpeakerFrameLegacySourceSignatures({
							layer: element,
							bindings,
							mediaAssets,
							settings,
							maxTrackIndexShift: getDisplayTracks({ tracks: sceneTracks })
								.length,
						});
					const sources = bindings.flatMap(
						({ trackId, trackIndex, element: source }) => {
							const mediaAsset = mediaMap.get(source.mediaId);
							if (
								!mediaAsset ||
								mediaAsset.type !== "video" ||
								(!mediaAsset.url && !mediaAsset.file)
							) {
								return [];
							}
							const camera = readCameraLayerSettings({
								params: source.params,
							});
							return [
								{
									trackId,
									trackIndex,
									elementId: source.id,
									mediaId: source.mediaId,
									url: mediaAsset.url,
									file: mediaAsset.file,
									duration: source.duration,
									timeOffset: source.startTime,
									trimStart: source.trimStart,
									trimEnd: source.trimEnd,
									retime: source.retime,
									transform: buildTransformFromParams({
										params: source.params,
									}),
									animations: removeSourceLayoutAnimations({
										animations: buildTransitionAnimationsFromElement({
											element: source,
										}),
									}),
									opacity: readOpacityFromParams({
										params: source.params,
									}),
									blendMode: readBlendModeFromParams({
										params: source.params,
									}),
									effects: source.effects ?? [],
									cameraDepth: camera.depth,
									cameraLocked: camera.locked,
								},
							];
						},
					);
					nodes.push(
						new SpeakerFrameBreakoutNode({
							layerId: element.id,
							timeOffset: element.startTime,
							duration: element.duration,
							settings,
							currentSourceSignature: sourceSignature,
							isAppliedAndCurrent: isSpeakerFrameBreakoutAppliedAndCurrent({
								layer: element,
								signature: sourceSignature,
								legacySignatures: legacySourceSignatures,
							}),
							isPreview: isPreview ?? false,
							sources,
						}),
					);
					continue;
				}
				if (isPersonCutoutLayerElement(element)) {
					const storedSettings = readPersonCutoutLayerSettings({
						params: element.params,
					});
					const fade = readPersonCutoutLayerFade({ element });
					const settings = {
						...storedSettings,
						...fade,
					};
					const bindings = getSpeakerFrameSourceBindings({
						tracks: sceneTracks,
						smartTrackId: track.id,
						layer: element,
					});
					const sourceSignature = buildPersonCutoutLayerSourceSignature({
						layer: element,
						bindings,
						mediaAssets,
						settings,
					});
					const legacySourceSignatures =
						buildPersonCutoutLayerLegacySourceSignatures({
							layer: element,
							bindings,
							mediaAssets,
							settings,
							maxTrackIndexShift: getDisplayTracks({ tracks: sceneTracks })
								.length,
						});
					const sources = bindings.flatMap(
						({ trackId, trackIndex, element: source }) => {
							const mediaAsset = mediaMap.get(source.mediaId);
							if (
								!mediaAsset ||
								mediaAsset.type !== "video" ||
								(!mediaAsset.url && !mediaAsset.file)
							) {
								return [];
							}
							const camera = readCameraLayerSettings({
								params: source.params,
							});
							return [
								{
									trackId,
									trackIndex,
									elementId: source.id,
									mediaId: source.mediaId,
									url: mediaAsset.url,
									file: mediaAsset.file,
									duration: source.duration,
									timeOffset: source.startTime,
									trimStart: source.trimStart,
									trimEnd: source.trimEnd,
									retime: source.retime,
									transform: buildTransformFromParams({
										params: source.params,
									}),
									animations: removeSourceLayoutAnimations({
										animations: buildTransitionAnimationsFromElement({
											element: source,
										}),
									}),
									opacity: readOpacityFromParams({
										params: source.params,
									}),
									blendMode: readBlendModeFromParams({
										params: source.params,
									}),
									effects: source.effects ?? [],
									cameraDepth: camera.depth,
									cameraLocked: camera.locked,
								},
							];
						},
					);
					nodes.push(
						new PersonCutoutLayerNode({
							layerId: element.id,
							timeOffset: element.startTime,
							duration: element.duration,
							settings,
							currentSourceSignature: sourceSignature,
							isAppliedAndCurrent: isPersonCutoutLayerAppliedAndCurrent({
								layer: element,
								signature: sourceSignature,
								legacySignatures: legacySourceSignatures,
							}),
							isPreview: isPreview ?? false,
							sources,
						}),
					);
					continue;
				}
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						effectAnimations: element.animations,
						cameraWidth: cameraCanvasSize.width,
						cameraHeight: cameraCanvasSize.height,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const camera = isParallaxCanvasScene
					? {
							depth: 1,
							locked: false,
							motionFactor: getParallaxWorldMotionFactor({
								assignment: parallaxAssignment,
							}),
						}
					: readCameraLayerSettings({ params: element.params });
				const referencedAsset = mediaMap.get(element.mediaId);
				const mediaAsset =
					element.type === "video" && referencedAsset
						? resolveUnifiedAnglesVideoAsset({
								asset: referencedAsset,
								angleAssetId: element.unifiedAngleId,
								mediaMap,
							})
						: referencedAsset;
				if (!mediaAsset) continue;

				if (element.type === "video" && mediaAsset.type === "video") {
					if (!mediaAsset.url && !mediaAsset.file) continue;
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							file: mediaAsset.file,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							transform: buildTransformFromParams({ params: element.params }),
							fitMode: element.fitMode ?? "contain",
							animations: buildTransitionAnimationsFromElement({ element }),
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							backgroundRemoval: element.backgroundRemoval,
							isPreview: isPreview ?? false,
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_VIDEO_SIZE,
							}),
							cameraDepth: camera.depth,
							cameraLocked: camera.locked,
							cameraMotionFactor: camera.motionFactor,
							cameraCanvasWidth: cameraCanvasSize.width,
							cameraCanvasHeight: cameraCanvasSize.height,
						}),
					);
				}
				if (element.type === "image" && mediaAsset.type === "image") {
					if (!mediaAsset.url) continue;
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: buildTransitionAnimationsFromElement({ element }),
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							cameraDepth: camera.depth,
							cameraLocked: camera.locked,
							cameraMotionFactor: camera.motionFactor,
							cameraCanvasWidth: cameraCanvasSize.width,
							cameraCanvasHeight: cameraCanvasSize.height,
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				const camera = isParallaxCanvasScene
					? {
							depth: 1,
							locked: false,
							motionFactor: getParallaxWorldMotionFactor({
								assignment: parallaxAssignment,
							}),
						}
					: readCameraLayerSettings({ params: element.params });
				const clipMediaAsset = element.clipMediaId
					? mediaMap.get(element.clipMediaId)
					: undefined;
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						animations: buildTransitionAnimationsFromElement({ element }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: {
							x: cameraCanvasSize.width / 2,
							y: cameraCanvasSize.height / 2,
						},
						canvasHeight: cameraCanvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
						clipMediaAsset,
						cameraDepth: camera.depth,
						cameraLocked: camera.locked,
						cameraMotionFactor: camera.motionFactor,
						cameraCanvasWidth: cameraCanvasSize.width,
						cameraCanvasHeight: cameraCanvasSize.height,
						worldPinned: isParallaxCanvasScene,
					}),
				);
			}

			if (element.type === "sticker") {
				const camera = isParallaxCanvasScene
					? {
							depth: 1,
							locked: false,
							motionFactor: getParallaxWorldMotionFactor({
								assignment: parallaxAssignment,
							}),
						}
					: readCameraLayerSettings({ params: element.params });
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: buildTransitionAnimationsFromElement({ element }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						cameraDepth: camera.depth,
						cameraLocked: camera.locked,
						cameraMotionFactor: camera.motionFactor,
						cameraCanvasWidth: cameraCanvasSize.width,
						cameraCanvasHeight: cameraCanvasSize.height,
					}),
				);
			}

			if (element.type === "graphic") {
				const camera = isParallaxCanvasScene
					? {
							depth: 1,
							locked: false,
							motionFactor: getParallaxWorldMotionFactor({
								assignment: parallaxAssignment,
							}),
						}
					: readCameraLayerSettings({ params: element.params });
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: buildTransitionAnimationsFromElement({ element }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
						cameraDepth: camera.depth,
						cameraLocked: camera.locked,
						cameraMotionFactor: camera.motionFactor,
						cameraCanvasWidth: cameraCanvasSize.width,
						cameraCanvasHeight: cameraCanvasSize.height,
					}),
				);
			}
		}
	}

	return nodes;
}

const SPEAKER_FRAME_SOURCE_LAYOUT_ANIMATION_PATHS = new Set([
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
]);

function removeSourceLayoutAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const result: ElementAnimations = {};
	for (const [propertyPath, channel] of Object.entries(animations)) {
		if (!SPEAKER_FRAME_SOURCE_LAYOUT_ANIMATION_PATHS.has(propertyPath)) {
			result[propertyPath] = channel;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const referencedAsset = mediaMap.get(element.mediaId);
		const mediaAsset =
			element.type === "video" && referencedAsset
				? resolveUnifiedAnglesVideoAsset({
						asset: referencedAsset,
						angleAssetId: element.unifiedAngleId,
						mediaMap,
					})
				: referencedAsset;
		if (
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	cameraCanvasSize?: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
	scenes?: TScene[];
	activeSceneId?: string;
	editorCameraEffectParams?: ParamValues;
	editorCameraEffectAnimations?: ElementAnimations;
};

export function buildScene({
	canvasSize,
	cameraCanvasSize = canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	scenes = [],
	activeSceneId,
	editorCameraEffectParams,
	editorCameraEffectAnimations,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = getDisplayTracks({ tracks }).filter(
		(track) => !("hidden" in track && track.hidden) && track.type !== "audio",
	);
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		sceneTracks: tracks,
		mediaMap,
		mediaAssets,
		canvasSize,
		cameraCanvasSize,
		isPreview,
		scenes,
		visitedSceneIds: new Set(activeSceneId ? [activeSceneId] : []),
		isParallaxCanvasScene: Boolean(
			activeSceneId &&
			scenes.find((scene) => scene.id === activeSceneId)?.parallax,
		),
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(
			new ColorNode({ color: background.color, screenLocked: true }),
		);
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	if (editorCameraEffectParams) {
		rootNode.add(
			new EffectLayerNode({
				effectType: CUSTOM_AI_EFFECT_TYPE,
				effectParams: editorCameraEffectParams,
				effectAnimations: editorCameraEffectAnimations,
				timeOffset: 0,
				duration,
				cameraWidth: cameraCanvasSize.width,
				cameraHeight: cameraCanvasSize.height,
			}),
		);
	}

	return rootNode;
}
