import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import {
	getElementLocalTime,
	resolveAnimationPathValueAtTime,
} from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { getEffectDefinition, resolveEffectPasses } from "@/effects";
import { resolveOverlayMovementFrame } from "@/effects/overlay-movement-presets";
import type { Effect, EffectPass } from "@/effects/types";
import { getSourceTimeAtClipTime } from "@/retime";
import { CUSTOM_AI_EFFECT_TYPE } from "@/effects/custom-ai-effect";
import {
	getGraphicDefinition,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { videoCache } from "@/services/video-cache/service";
import type { CanvasRenderer } from "./canvas-renderer";
import { resolveEffectLayerVisualOverlay } from "./effect-layer-visual-overlay";
import type { AnyBaseNode } from "./nodes/base-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { StickerNode, loadStickerSource } from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type { ResolvedVideoNodeState } from "./nodes/video-node";
import {
	SpeakerFrameBreakoutNode,
	type ResolvedSpeakerFrameBreakoutNodeState,
} from "./nodes/speaker-frame-breakout-node";
import {
	ParallaxSceneNode,
	type ResolvedParallaxSceneNodeState,
} from "./nodes/parallax-scene-node";
import { resolveBackgroundRemovalSettings } from "@/background-removal";
import { backgroundRemovalService } from "@/services/background-removal";
import { speakerFrameLayoutScale } from "@/simple-advanced-layers/speaker-frame-breakout";
import { incrementCounter } from "@/diagnostics/render-perf";
import {
	isStaticRenderNode,
	isStaticRenderNodeActiveAtTime,
} from "./static-node-cache";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";
import { mapParallaxParentTimeToSourceTime } from "@/parallax-story-teller/camera-geometry";
import { resolveParallaxMotionLoopFrame } from "@/parallax-story-teller/motion-loop";

type ResolveContext = {
	renderer: Pick<CanvasRenderer, "width" | "height">;
	time: number;
};

type StaticResolutionCacheEntry = {
	width: number;
	height: number;
	active: boolean;
	params: object | undefined;
	resolved: unknown;
};

const staticResolutionCache = new WeakMap<
	AnyBaseNode,
	StaticResolutionCacheEntry
>();

export async function resolveRenderTree({
	node,
	renderer,
	time,
}: {
	node: AnyBaseNode;
	renderer: Pick<CanvasRenderer, "width" | "height">;
	time: number;
}): Promise<void> {
	await resolveNode({
		node,
		context: {
			renderer,
			time,
		},
	});
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	const isStatic = isStaticRenderNode(node);
	const active = isStatic
		? isStaticRenderNodeActiveAtTime({ node, time: context.time })
		: false;
	const cached = isStatic ? staticResolutionCache.get(node) : undefined;
	const params = isStatic ? node.params : undefined;
	const canReuse =
		isStatic &&
		cached &&
		cached.width === context.renderer.width &&
		cached.height === context.renderer.height &&
		cached.active === active &&
		cached.params === params;

	if (canReuse) {
		incrementCounter({ name: "resolveCache.staticNodeHit" });
		node.resolved = cached.resolved;
		// Static render nodes do not own time-varying children. Avoid descending
		// into the subtree once their resolved state is known to be reusable.
		return;
	} else if (isStatic && !active) {
		// Avoid loading/rasterizing static media before its clip enters view.
		node.resolved = null;
	} else if (node instanceof VideoNode) {
		node.resolved = await resolveVideoNode({ node, context });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = await resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = await resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof SpeakerFrameBreakoutNode) {
		node.resolved = await resolveSpeakerFrameBreakoutNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	} else if (node instanceof ParallaxSceneNode) {
		node.resolved = resolveParallaxSceneNode({ node, context });
	}

	if (isStatic) {
		staticResolutionCache.set(node, {
			width: context.renderer.width,
			height: context.renderer.height,
			active,
			params,
			resolved: node.resolved,
		});
	}

	const childContext =
		node instanceof ParallaxSceneNode
			? {
					...context,
					time: mapParallaxParentTimeToSourceTime({
						time: context.time,
						timeOffset: node.params.timeOffset,
						duration: node.params.duration,
						sourceDuration: node.params.sourceDuration,
					}),
				}
			: context;
	await Promise.all(
		node.children.map((child) =>
			resolveNode({ node: child, context: childContext }),
		),
	);
}

function resolveParallaxSceneNode({
	node,
	context,
}: {
	node: ParallaxSceneNode;
	context: ResolveContext;
}): ResolvedParallaxSceneNodeState | null {
	const localTime = context.time - node.params.timeOffset;
	if (localTime < 0 || localTime >= node.params.duration) return null;
	const sourceTime = mapParallaxParentTimeToSourceTime({
		time: context.time,
		timeOffset: node.params.timeOffset,
		duration: node.params.duration,
		sourceDuration: node.params.sourceDuration,
	});
	const cameraTime = node.params.cameraUsesSourceTime
		? sourceTime - node.params.cameraTimeOffset
		: localTime;
	const movement = resolveOverlayMovementFrame({
		effectParams: node.params.effectParams,
		animations: node.params.effectAnimations,
		localTime: cameraTime,
		duration: node.params.cameraDuration,
		width: node.params.cameraWidth ?? context.renderer.width,
		height: node.params.cameraHeight ?? context.renderer.height,
	});
	return movement
		? {
				movement: {
					...movement,
					// Camera coordinates describe the center of the viewport in world
					// units. Translation therefore belongs inside the zoom transform.
					translateX: movement.translateX * movement.scale,
					translateY: movement.translateY * movement.scale,
				},
				motionLoop: resolveParallaxMotionLoopFrame({
					params: node.params.storyParams,
					localTime,
					duration: node.params.duration,
					width: node.params.cameraWidth ?? context.renderer.width,
					height: node.params.cameraHeight ?? context.renderer.height,
				}),
			}
		: null;
}

async function resolveSpeakerFrameBreakoutNode({
	node,
	context,
}: {
	node: SpeakerFrameBreakoutNode;
	context: ResolveContext;
}): Promise<ResolvedSpeakerFrameBreakoutNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}
	if (!node.params.isAppliedAndCurrent) {
		if (!node.params.isPreview) {
			throw new Error(
				"Speaker Frame Breakout source changed after Apply. Reapply the layer before export.",
			);
		}
		return null;
	}
	const source = node.params.sources.find(
		(candidate) =>
			context.time >= candidate.timeOffset &&
			context.time < candidate.timeOffset + candidate.duration,
	);
	if (!source) return null;

	const sourceClipTime = context.time - source.timeOffset;
	const sourceTimeTicks =
		source.trimStart +
		getSourceTimeAtClipTime({
			clipTime: sourceClipTime,
			retime: source.retime,
		});
	const sourceTime = mediaTimeToSeconds({
		time: roundMediaTime({ time: sourceTimeTicks }),
	});
	const frame = await videoCache.getFrameAt({
		mediaId: source.mediaId,
		file: source.file,
		url: source.url,
		time: sourceTime,
	});
	if (!frame) {
		const previous = node.resolved;
		if (
			node.params.isPreview &&
			previous?.sourceElementId === source.elementId &&
			Math.abs(previous.sourceTime - sourceTime) <= 0.15
		) {
			return previous;
		}
		return null;
	}

	const visualState = resolveVisualState({
		params: {
			duration: source.duration,
			timeOffset: source.timeOffset,
			trimStart: source.trimStart,
			trimEnd: source.trimEnd,
			retime: source.retime,
			transform: {
				...source.transform,
				position: {
					x: node.params.settings.positionX,
					y: node.params.settings.positionY,
				},
				scaleX: speakerFrameLayoutScale({
					layoutScale: node.params.settings.scaleX,
					sourceScale: source.transform.scaleX,
				}),
				scaleY: speakerFrameLayoutScale({
					layoutScale: node.params.settings.scaleY,
					sourceScale: source.transform.scaleY,
				}),
			},
			animations: source.animations,
			opacity: source.opacity,
			blendMode: source.blendMode,
			effects: source.effects,
			cameraDepth: source.cameraDepth,
			cameraLocked: source.cameraLocked,
		},
		context,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	});
	if (!visualState) return null;

	const settings = resolveBackgroundRemovalSettings({
		settings: node.params.settings.matte,
	});
	let mask = backgroundRemovalService.getPreparedMaskFrame({
		groupKey: node.params.settings.matteCacheKey,
		mediaId: source.mediaId,
		sourceTime,
		settings,
	});
	if (!mask) {
		if (node.params.isPreview) {
			mask = backgroundRemovalService.getPreviewMaskOrSchedule({
				source: frame.canvas,
				mediaId: source.mediaId,
				sourceTime,
				settings,
			});
			if (!mask) {
				const previous = node.resolved;
				const maxMaskHoldSeconds = Math.max(0.15, 2 / settings.previewFps);
				if (
					previous?.sourceElementId === source.elementId &&
					previous.mask &&
					Math.abs(previous.sourceTime - sourceTime) <= maxMaskHoldSeconds
				) {
					mask = previous.mask;
				}
			}
		} else {
			await backgroundRemovalService.hydratePreparedGroup({
				groupKey: node.params.settings.matteCacheKey,
			});
			mask = backgroundRemovalService.getPreparedMaskFrame({
				groupKey: node.params.settings.matteCacheKey,
				mediaId: source.mediaId,
				sourceTime,
				settings,
			});
			if (!mask) {
				// A browser cleanup, reload, or older project can lose the
				// prepared cache while the applied source snapshot remains valid.
				// Rebuild the quantized matte on demand so export stays complete.
				mask = await backgroundRemovalService.segmentFrame({
					source: frame.canvas,
					mediaId: source.mediaId,
					sourceTime,
					settings,
					isPreview: true,
					temporalSequenceKey: node.params.settings.matteCacheKey,
				});
			}
		}
	}

	const localSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: clipTime }),
	});
	const durationSeconds = mediaTimeToSeconds({
		time: roundMediaTime({ time: node.params.duration }),
	});
	const fadeIn =
		node.params.settings.fadeInDuration <= 0
			? 1
			: smoothstep01(localSeconds / node.params.settings.fadeInDuration);
	const secondsRemaining = Math.max(0, durationSeconds - localSeconds);
	const fadeOut =
		node.params.settings.fadeOutDuration <= 0
			? 1
			: smoothstep01(secondsRemaining / node.params.settings.fadeOutDuration);

	return {
		source: frame.canvas,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
		sourceElementId: source.elementId,
		sourceMediaId: source.mediaId,
		sourceTime,
		backgroundParams: node.params.settings.backgroundParams,
		mask,
		transform: visualState.transform,
		cropTop: node.params.settings.cropTop,
		cornerRadius: node.params.settings.cornerRadius,
		opacity: Math.min(fadeIn, fadeOut),
		sourceOpacity: visualState.opacity,
		blendMode: source.blendMode,
		effectPassGroups: visualState.effectPasses,
		cameraDepth: source.cameraDepth,
		cameraLocked: source.cameraLocked,
		localTime: localSeconds,
	};
}

function smoothstep01(value: number): number {
	const clamped = Math.max(0, Math.min(1, value));
	return clamped * clamped * (3 - 2 * clamped);
}

function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	width: number;
	height: number;
}): EffectPass[][] {
	return (effects ?? [])
		.filter((effect) => effect.enabled)
		.map((effect) => {
			const resolvedParams = resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime,
			});
			const definition = getEffectDefinition(effect.type);
			return resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
				localTime,
			});
		})
		.filter((passes) => passes.length > 0);
}

function resolveVisualState({
	params,
	context,
	sourceWidth,
	sourceHeight,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	sourceWidth: number;
	sourceHeight: number;
}): ResolvedVisualNodeState | null {
	const clipTime = context.time - params.timeOffset;
	if (clipTime < 0 || clipTime >= params.duration) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const transform = resolveTransformAtTime({
		baseTransform: params.transform,
		animations: params.animations,
		localTime,
	});
	const opacity = resolveOpacityAtTime({
		baseOpacity: params.opacity,
		animations: params.animations,
		localTime,
	});
	const cameraWidth = params.cameraCanvasWidth ?? context.renderer.width;
	const cameraHeight = params.cameraCanvasHeight ?? context.renderer.height;
	const containScale = Math.min(
		cameraWidth / sourceWidth,
		cameraHeight / sourceHeight,
	);
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);

	const effectPasses = resolveEffectPassGroups({
		effects: params.effects,
		animations: params.animations,
		localTime,
		width: effectWidth,
		height: effectHeight,
	});
	const shatterProgress = resolveAnimationPathValueAtTime({
		animations: params.animations,
		propertyPath: "transition.shatter",
		localTime,
		fallbackValue: 0,
	});
	if (shatterProgress > 0.0001) {
		effectPasses.push([
			{
				shader: "shatter",
				uniforms: { u_progress: shatterProgress, u_seed: 17 },
			},
		]);
	}

	return {
		localTime,
		transform,
		opacity,
		effectPasses,
	};
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<ResolvedVideoNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const sourceTimeTicks =
		node.params.trimStart +
		getSourceTimeAtClipTime({
			clipTime,
			retime: node.params.retime,
		});
	const frame = await videoCache.getFrameAt({
		mediaId: node.params.mediaId,
		file: node.params.file,
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
		time: mediaTimeToSeconds({
			time: roundMediaTime({ time: sourceTimeTicks }),
		}),
	});
	if (!frame) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	});
	if (!visualState) {
		return null;
	}

	let backgroundRemoval: ResolvedVideoNodeState["backgroundRemoval"];
	if (node.params.backgroundRemoval?.enabled) {
		const settings = resolveBackgroundRemovalSettings({
			settings: node.params.backgroundRemoval,
		});
		try {
			const sourceTime = mediaTimeToSeconds({
				time: roundMediaTime({ time: sourceTimeTicks }),
			});
			const mask = node.params.isPreview
				? backgroundRemovalService.getPreviewMaskOrSchedule({
						source: frame.canvas,
						mediaId: node.params.mediaId,
						sourceTime,
						settings,
					})
				: await backgroundRemovalService.segmentFrame({
						source: frame.canvas,
						mediaId: node.params.mediaId,
						sourceTime,
						settings,
						isPreview: false,
					});
			if (!mask) {
				return {
					...visualState,
					source: frame.canvas,
					sourceWidth: frame.canvas.width,
					sourceHeight: frame.canvas.height,
				};
			}
			const resolutionScale = Math.max(
				0.5,
				Math.min(context.renderer.width / 1920, context.renderer.height / 1080),
			);
			const backgroundEffectPasses =
				settings.mode === "blur"
					? [
							buildGaussianBlurPasses({
								sigmaX: settings.blurSigma * resolutionScale,
								sigmaY: settings.blurSigma * resolutionScale,
							}),
						]
					: settings.mode === "grayscale"
						? [[{ shader: "grayscale", uniforms: {} }]]
						: [];
			backgroundRemoval = { mask, settings, backgroundEffectPasses };
		} catch {
			// Keep the original frame visible; the properties panel exposes the
			// worker error and an explicit retry action.
		}
	}

	return {
		...visualState,
		source: frame.canvas,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
		backgroundRemoval,
	};
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth: source.width,
		sourceHeight: source.height,
	};
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadStickerSource({ stickerId: node.params.stickerId });
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

async function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): Promise<ResolvedGraphicNodeState | null> {
	const { width: sourceWidth, height: sourceHeight } = node.getSourceSize();
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	const resolvedParams = resolveGraphicElementParamsAtTime({
		element: node.params,
		localTime: visualState.localTime,
	});
	const definition = getGraphicDefinition({
		definitionId: node.params.definitionId,
	});
	await definition.prepare?.({
		params: resolvedParams,
		width: sourceWidth,
		height: sourceHeight,
		localTime: visualState.localTime,
		duration: node.params.duration,
	});

	return {
		...visualState,
		resolvedParams,
		sourceWidth,
		sourceHeight,
	};
}

async function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): Promise<ResolvedTextNodeState | null> {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });
	const cameraWidth = node.params.cameraCanvasWidth ?? context.renderer.width;
	const cameraHeight =
		node.params.cameraCanvasHeight ?? context.renderer.height;
	let clipMediaSource: CanvasImageSource | undefined;
	const clipMedia = node.params.clipMediaAsset;
	if (clipMedia?.url && clipMedia.type === "image") {
		clipMediaSource = (await loadImageSource({ url: clipMedia.url })).source;
	} else if (clipMedia?.url && clipMedia.type === "video") {
		const mediaDuration = Math.max(
			0.001,
			clipMedia.duration ?? node.params.duration,
		);
		const frame = await videoCache.getFrameAt({
			mediaId: clipMedia.id,
			file: clipMedia.file,
			url: clipMedia.url,
			time: localTime % mediaDuration,
		});
		clipMediaSource = frame?.canvas;
	}

	return {
		transform: resolveTransformAtTime({
			baseTransform: node.params.transform,
			animations: node.params.animations,
			localTime,
		}),
		opacity: resolveOpacityAtTime({
			baseOpacity: node.params.opacity,
			animations: node.params.animations,
			localTime,
		}),
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		effectPasses: resolveEffectPassGroups({
			effects: node.params.effects,
			animations: node.params.animations,
			localTime,
			width: cameraWidth,
			height: cameraHeight,
		}),
		measuredText: measureTextElement({
			element: node.params,
			canvasHeight: cameraHeight,
			localTime,
			ctx: getTextMeasurementContext(),
		}),
		clipMediaSource,
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const backdropSource = await resolveBackdropSource({ node, clipTime });
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.height,
				reference: 1080,
			}),
		}),
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
}): Promise<BackdropSource | null> {
	if (node.params.mediaType === "video") {
		const sourceTimeTicks =
			node.params.trimStart +
			getSourceTimeAtClipTime({
				clipTime,
				retime: node.params.retime,
			});
		const frame = await videoCache.getFrameAt({
			mediaId: node.params.mediaId,
			file: node.params.file,
			url: node.params.url,
			time: mediaTimeToSeconds({
				time: roundMediaTime({ time: sourceTimeTicks }),
			}),
		});
		if (!frame) {
			return null;
		}

		return {
			source: frame.canvas,
			width: frame.canvas.width,
			height: frame.canvas.height,
		};
	}

	const source = await loadImageSource({ url: node.params.url });
	return {
		source: source.source,
		width: source.width,
		height: source.height,
	};
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const localTime = time - node.params.timeOffset;
	const definition = getEffectDefinition(node.params.effectType);
	const movement =
		definition.type === CUSTOM_AI_EFFECT_TYPE
			? resolveOverlayMovementFrame({
					effectParams: node.params.effectParams,
					animations: node.params.effectAnimations,
					localTime,
					duration: node.params.duration,
					width: node.params.cameraWidth ?? context.renderer.width,
					height: node.params.cameraHeight ?? context.renderer.height,
				})
			: null;
	const passes = movement
		? []
		: resolveEffectPasses({
				definition,
				effectParams: node.params.effectParams,
				width: context.renderer.width,
				height: context.renderer.height,
				localTime,
			});
	const visualOverlay =
		definition.type === CUSTOM_AI_EFFECT_TYPE && !movement
			? resolveEffectLayerVisualOverlay({
					effectType: node.params.effectType,
					effectParams: node.params.effectParams,
					localTime,
					duration: node.params.duration,
				})
			: null;
	if (passes.length > 0 || visualOverlay || movement) {
		return {
			passes,
			visualOverlay,
			movement,
			overlay: null,
		};
	}

	// Unknown custom specs are metadata, not pixels. Rendering a diagnostic
	// card here would silently place editor internals into preview and export.
	return null;
}
