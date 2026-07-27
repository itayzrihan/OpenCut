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
import { resolveBackgroundRemovalSettings } from "@/background-removal";
import { backgroundRemovalService } from "@/services/background-removal";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";

type ResolveContext = {
	renderer: Pick<CanvasRenderer, "width" | "height">;
	time: number;
};

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
	if (node instanceof VideoNode) {
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
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}

	await Promise.all(
		node.children.map((child) => resolveNode({ node: child, context })),
	);
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
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
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
			const mask = await backgroundRemovalService.segmentFrame({
				source: frame.canvas,
				mediaId: node.params.mediaId,
				sourceTime,
				settings,
				isPreview: node.params.isPreview,
			});
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
			width: context.renderer.width,
			height: context.renderer.height,
		}),
		measuredText: measureTextElement({
			element: node.params,
			canvasHeight: node.params.canvasHeight,
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
					localTime,
					duration: node.params.duration,
					width: context.renderer.width,
					height: context.renderer.height,
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
