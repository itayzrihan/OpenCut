import { drawCssBackground } from "@/gradients";
import { getGraphicDefinition, getGraphicLayoutSize } from "@/graphics";
import { getMaskDefinition } from "@/masks";
import { incrementCounter } from "@/diagnostics/render-perf";
import type { AnyBaseNode } from "../nodes/base-node";
import type { CanvasRenderer } from "../canvas-renderer";
import { createCanvasSurface } from "../canvas-utils";
import {
	drawEffectLayerVisualOverlay,
	type EffectLayerVisualOverlay,
} from "../effect-layer-visual-overlay";
import { BlurBackgroundNode } from "../nodes/blur-background-node";
import { ColorNode } from "../nodes/color-node";
import { EffectLayerNode } from "../nodes/effect-layer-node";
import type { EffectLayerOverlay } from "../nodes/effect-layer-node";
import type { OverlayMovementFrame } from "@/effects/overlay-movement-presets";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "../nodes/graphic-node";
import { ImageNode } from "../nodes/image-node";
import { RootNode } from "../nodes/root-node";
import { StickerNode } from "../nodes/sticker-node";
import { renderTextToContext, TextNode } from "../nodes/text-node";
import { VideoNode } from "../nodes/video-node";
import { SpeakerFrameBreakoutNode } from "../nodes/speaker-frame-breakout-node";
import { PersonCutoutLayerNode } from "../nodes/person-cutout-layer-node";
import { ParallaxSceneNode } from "../nodes/parallax-scene-node";
import type { ResolvedVisualSourceNodeState } from "../nodes/visual-node";
import { resolveCameraDepthFactor } from "@/effects/virtual-camera";
import { getParallaxWorldOriginOffset } from "@/parallax-story-teller/camera-geometry";
import { isStaticRenderNode } from "../static-node-cache";
import {
	resolveVisualFitScale,
	type VisualFitMode,
} from "@/rendering/fit-mode";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	LayerMaskDescriptor,
	QuadTransformDescriptor,
	TextureCanvasDrawFn,
	TextureUploadDescriptor,
} from "./types";

type RendererSize = Pick<CanvasRenderer, "width" | "height">;

type CameraLayerMetadata = {
	depth: number;
	locked: boolean;
	motionFactor?: number;
};

type CameraAwareLayer = Extract<FrameItemDescriptor, { type: "layer" }> &
	Record<symbol, CameraLayerMetadata | undefined>;

type StaticFrameFragment = {
	path: string;
	width: number;
	height: number;
	params: object | undefined;
	resolved: unknown;
	items: FrameItemDescriptor[];
	textures: TextureUploadDescriptor[];
};

const staticFrameFragmentCache = new WeakMap<
	AnyBaseNode,
	StaticFrameFragment
>();

export async function buildFrameDescriptor({
	node,
	renderer,
}: {
	node: AnyBaseNode;
	renderer: RendererSize;
}): Promise<{
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
}> {
	const items: FrameItemDescriptor[] = [];
	const textures = new Map<string, TextureUploadDescriptor>();

	await collectNode({
		node,
		renderer,
		path: "root",
		items,
		textures,
	});

	incrementCounter({ name: "frameItems", by: items.length });
	incrementCounter({ name: "frameTextures", by: textures.size });

	return {
		frame: {
			width: renderer.width,
			height: renderer.height,
			clear: {
				color: [0, 0, 0, 1],
			},
			items,
		},
		textures: [...textures.values()],
	};
}

async function collectNode(args: {
	node: AnyBaseNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}): Promise<void> {
	const { node, renderer, path, items, textures } = args;
	if (!isStaticRenderNode(node)) {
		await collectNodeUncached(args);
		return;
	}

	const cached = staticFrameFragmentCache.get(node);
	if (
		cached &&
		cached.path === path &&
		cached.width === renderer.width &&
		cached.height === renderer.height &&
		cached.params === node.params &&
		cached.resolved === node.resolved
	) {
		incrementCounter({ name: "frameCache.staticNodeHit" });
		appendFrameFragment({ fragment: cached, items, textures });
		return;
	}

	const fragment: StaticFrameFragment = {
		path,
		width: renderer.width,
		height: renderer.height,
		params: node.params,
		resolved: node.resolved,
		items: [],
		textures: [],
	};
	const fragmentTextures = new Map<string, TextureUploadDescriptor>();
	await collectNodeUncached({
		...args,
		items: fragment.items,
		textures: fragmentTextures,
	});
	fragment.textures = [...fragmentTextures.values()];
	staticFrameFragmentCache.set(node, fragment);
	appendFrameFragment({ fragment, items, textures });
}

function appendFrameFragment({
	fragment,
	items,
	textures,
}: {
	fragment: StaticFrameFragment;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}): void {
	// Overlay movement applies transforms in place. Keep cached fragments
	// immutable so a dynamic effect cannot accumulate its transform into the
	// static cache and corrupt later frames.
	items.push(...fragment.items.map(cloneFrameItemForFrame));
	for (const texture of fragment.textures) {
		textures.set(texture.id, texture);
	}
}

function cloneFrameItemForFrame(
	item: FrameItemDescriptor,
): FrameItemDescriptor {
	if (item.type === "layer") {
		return {
			...item,
			transform: { ...item.transform },
		};
	}

	if (item.type === "group") {
		return {
			...item,
			items: item.items.map(cloneFrameItemForFrame),
		};
	}

	return {
		...item,
		effect_pass_groups: item.effect_pass_groups,
	};
}

async function collectNodeUncached({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: AnyBaseNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}): Promise<void> {
	if (node instanceof RootNode) {
		for (let index = 0; index < node.children.length; index++) {
			await collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:${index}`,
				items,
				textures,
			});
		}
		return;
	}

	if (node instanceof ColorNode) {
		const textureId = `${path}:color`;
		const { width, height } = renderer;
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash: `color:${node.params.color}:${width}x${height}`,
			width,
			height,
			draw: (ctx) => {
				if (/gradient\(/i.test(node.params.color)) {
					drawCssBackground({ ctx, width, height, css: node.params.color });
				} else {
					ctx.fillStyle = node.params.color;
					ctx.fillRect(0, 0, width, height);
				}
			},
		});
		const layer: Extract<FrameItemDescriptor, { type: "layer" }> = {
			type: "layer",
			textureId,
			transform: fullCanvasTransform({ renderer }),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		};
		setCameraLayerMetadata({
			layer,
			depth: 1,
			locked: node.params.screenLocked ?? false,
		});
		items.push(layer);
		return;
	}

	if (node instanceof SpeakerFrameBreakoutNode) {
		collectSpeakerFrameBreakout({
			node,
			renderer,
			path,
			items,
			textures,
		});
		return;
	}

	if (node instanceof PersonCutoutLayerNode) {
		collectPersonCutoutLayer({
			node,
			renderer,
			path,
			items,
			textures,
		});
		return;
	}

	if (node instanceof ParallaxSceneNode) {
		if (!node.resolved) return;
		const nestedItems: FrameItemDescriptor[] = [];
		for (let index = 0; index < node.children.length; index++) {
			await collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:parallax:${index}`,
				items: nestedItems,
				textures,
			});
		}
		rebaseParallaxWorldLayers({
			items: nestedItems,
			cameraWidth: node.params.cameraWidth ?? renderer.width,
			cameraHeight: node.params.cameraHeight ?? renderer.height,
			worldWidthFrames: node.params.worldWidthFrames,
			worldHeightFrames: node.params.worldHeightFrames,
		});
		applyOverlayMovementToCollectedLayers({
			movement: node.resolved.movement,
			renderer,
			cameraWidth: node.params.cameraWidth,
			cameraHeight: node.params.cameraHeight,
			items: nestedItems,
		});
		if (node.resolved.motionLoop) {
			applyParallaxMotionLoopToCollectedLayers({
				motionLoop: node.resolved.motionLoop,
				cameraWidth: node.params.cameraWidth ?? renderer.width,
				cameraHeight: node.params.cameraHeight ?? renderer.height,
				items: nestedItems,
			});
		}
		if (nestedItems.length > 0) {
			items.push({
				type: "group",
				items: nestedItems,
				opacity: 1,
				blendMode: "normal",
			});
		}
		return;
	}

	if (node instanceof EffectLayerNode) {
		if (!node.resolved) {
			return;
		}
		if (node.resolved.passes.length > 0) {
			items.push({
				type: "sceneEffect",
				effect_pass_groups: [node.resolved.passes],
			});
		}
		if (node.resolved.visualOverlay) {
			collectEffectVisualOverlay({
				visualOverlay: node.resolved.visualOverlay,
				renderer,
				path,
				items,
				textures,
			});
		}
		if (node.resolved.movement) {
			applyOverlayMovementToCollectedLayers({
				movement: node.resolved.movement,
				renderer,
				cameraWidth: node.params.cameraWidth,
				cameraHeight: node.params.cameraHeight,
				items,
			});
			if (node.resolved.movement.flashAlpha > 0) {
				collectOverlayMovementFlash({
					movement: node.resolved.movement,
					renderer,
					path,
					items,
					textures,
				});
			}
			if (
				node.resolved.movement.overlayAlpha > 0 ||
				node.resolved.movement.vignetteAlpha > 0
			) {
				collectOverlayMovementVisuals({
					movement: node.resolved.movement,
					renderer,
					path,
					items,
					textures,
				});
			}
		}
		if (node.resolved.overlay) {
			collectAiEffectOverlay({
				overlay: node.resolved.overlay,
				renderer,
				path,
				items,
				textures,
			});
		}
		return;
	}

	if (node instanceof BlurBackgroundNode) {
		if (!node.resolved) {
			return;
		}
		const textureId = `${path}:blur-background`;
		const { width, height } = renderer;
		const { backdropSource, passes } = node.resolved;
		// Backdrop pixels come from a decoded video/image frame whose identity
		// already changes when it changes. Hashing the source reference is
		// enough to let us skip redraws on frozen frames.
		const contentHash = `blur:${identityKey(backdropSource.source)}:${backdropSource.width}x${backdropSource.height}:${width}x${height}`;
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash,
			width,
			height,
			draw: (ctx) => {
				const coverScale = Math.max(
					width / backdropSource.width,
					height / backdropSource.height,
				);
				const scaledWidth = backdropSource.width * coverScale;
				const scaledHeight = backdropSource.height * coverScale;
				const offsetX = (width - scaledWidth) / 2;
				const offsetY = (height - scaledHeight) / 2;
				ctx.drawImage(
					backdropSource.source,
					offsetX,
					offsetY,
					scaledWidth,
					scaledHeight,
				);
			},
		});
		const layer: Extract<FrameItemDescriptor, { type: "layer" }> = {
			type: "layer",
			textureId,
			transform: fullCanvasTransform({ renderer }),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [passes],
			mask: null,
		};
		setCameraLayerMetadata({
			layer,
			depth: 1,
			locked: true,
		});
		items.push(layer);
		return;
	}

	if (
		node instanceof VideoNode ||
		node instanceof ImageNode ||
		node instanceof StickerNode ||
		node instanceof GraphicNode
	) {
		await collectVisualSourceNode({
			node,
			renderer,
			path,
			items,
			textures,
		});
		return;
	}

	if (node instanceof TextNode) {
		collectTextNode({
			node,
			renderer,
			path,
			items,
			textures,
		});
	}
}

function rebaseParallaxWorldLayers({
	items,
	cameraWidth,
	cameraHeight,
	worldWidthFrames,
	worldHeightFrames,
}: {
	items: FrameItemDescriptor[];
	cameraWidth: number;
	cameraHeight: number;
	worldWidthFrames: number;
	worldHeightFrames: number;
}) {
	const offset = getParallaxWorldOriginOffset({
		cameraWidth,
		cameraHeight,
		worldWidthFrames,
		worldHeightFrames,
	});
	for (const item of items) {
		if (item.type === "group") {
			rebaseParallaxWorldLayers({
				items: item.items,
				cameraWidth,
				cameraHeight,
				worldWidthFrames,
				worldHeightFrames,
			});
			continue;
		}
		if (item.type !== "layer") continue;
		item.transform = {
			...item.transform,
			centerX: item.transform.centerX - offset.x,
			centerY: item.transform.centerY - offset.y,
		};
	}
}

function collectSpeakerFrameBreakout({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: SpeakerFrameBreakoutNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const resolved = node.resolved;
	if (!resolved || resolved.opacity <= 0) return;
	const { width: canvasWidth, height: canvasHeight } = renderer;
	const groupItems: Array<Extract<FrameItemDescriptor, { type: "layer" }>> = [];
	const existingSourceTexture = [...textures.values()].find(
		(texture) =>
			texture.kind === "external" && texture.source === resolved.source,
	);
	const sourceTextureId = existingSourceTexture?.id ?? `${path}:speaker-source`;
	if (!existingSourceTexture) {
		textures.set(sourceTextureId, {
			kind: "external",
			id: sourceTextureId,
			source: resolved.source,
			width: resolved.sourceWidth,
			height: resolved.sourceHeight,
		});
	}

	const backgroundTextureId = `${path}:speaker-background`;
	const backgroundDefinition = getGraphicDefinition({
		definitionId: "preset-background",
	});
	const backgroundStyle = String(resolved.backgroundParams.preset ?? "clean");
	const backgroundTimeKey = isAnimatedBackgroundStyle(backgroundStyle)
		? `:${resolved.localTime.toFixed(3)}`
		: "";
	textures.set(backgroundTextureId, {
		kind: "rendered",
		id: backgroundTextureId,
		contentHash: `speaker-background:${canvasWidth}x${canvasHeight}:${JSON.stringify(resolved.backgroundParams)}${backgroundTimeKey}`,
		width: canvasWidth,
		height: canvasHeight,
		draw: (ctx) => {
			backgroundDefinition.render({
				ctx,
				params: resolved.backgroundParams,
				width: canvasWidth,
				height: canvasHeight,
				localTime: resolved.localTime,
				duration: node.params.duration,
			});
		},
	});
	const backgroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
		type: "layer",
		textureId: backgroundTextureId,
		transform: fullCanvasTransform({ renderer }),
		opacity: 1,
		blendMode: "normal",
		effectPassGroups: [],
		mask: null,
	};
	setCameraLayerMetadata({
		layer: backgroundLayer,
		depth: resolved.cameraDepth,
		locked: resolved.cameraLocked,
	});
	groupItems.push(backgroundLayer);

	const containScale = Math.min(
		canvasWidth / resolved.sourceWidth,
		canvasHeight / resolved.sourceHeight,
	);
	const scaledWidth =
		resolved.sourceWidth * containScale * resolved.transform.scaleX;
	const scaledHeight =
		resolved.sourceHeight * containScale * resolved.transform.scaleY;
	const transform: QuadTransformDescriptor = {
		centerX: canvasWidth / 2 + resolved.transform.position.x,
		centerY: canvasHeight / 2 + resolved.transform.position.y,
		width: Math.abs(scaledWidth),
		height: Math.abs(scaledHeight),
		rotationDegrees: resolved.transform.rotate,
		perspectiveXDegrees: resolved.transform.perspectiveX,
		perspectiveYDegrees: resolved.transform.perspectiveY,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
	};

	const frameMaskTextureId = `${path}:speaker-frame-mask`;
	textures.set(frameMaskTextureId, {
		kind: "rendered",
		id: frameMaskTextureId,
		contentHash: [
			"speaker-frame-mask",
			canvasWidth,
			canvasHeight,
			transformHash(transform),
			resolved.cropTop,
			resolved.cornerRadius,
		].join(":"),
		width: canvasWidth,
		height: canvasHeight,
		draw: (ctx) => {
			const safeCropTop = Math.max(0, Math.min(0.95, resolved.cropTop));
			const height = transform.height * (1 - safeCropTop);
			const radius =
				Math.max(0, Math.min(0.5, resolved.cornerRadius)) *
				Math.min(transform.width, height);
			const { canvas: localMask, context: localContext } = createCanvasSurface({
				width: Math.max(1, Math.round(transform.width)),
				height: Math.max(1, Math.round(transform.height)),
			});
			localContext.fillStyle = "white";
			localContext.beginPath();
			localContext.roundRect(
				0,
				transform.height * safeCropTop,
				transform.width,
				height,
				radius,
			);
			localContext.fill();
			drawTransformedCanvas({
				ctx,
				source: localMask,
				transform,
			});
		},
	});
	const baseLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
		type: "layer",
		textureId: sourceTextureId,
		transform,
		opacity: resolved.sourceOpacity,
		blendMode: resolved.blendMode,
		effectPassGroups: resolved.effectPassGroups,
		mask: {
			textureId: frameMaskTextureId,
			feather: 0,
			inverted: false,
		},
	};
	setCameraLayerMetadata({
		layer: baseLayer,
		depth: resolved.cameraDepth,
		locked: resolved.cameraLocked,
	});
	groupItems.push(baseLayer);

	if (resolved.mask) {
		const matteTextureId = `${path}:speaker-matte`;
		textures.set(matteTextureId, {
			kind: "external",
			id: matteTextureId,
			source: resolved.mask.canvas,
			width: resolved.mask.width,
			height: resolved.mask.height,
		});
		const breakoutMaskTextureId = `${path}:speaker-breakout-region`;
		textures.set(breakoutMaskTextureId, {
			kind: "rendered",
			id: breakoutMaskTextureId,
			contentHash: [
				"speaker-breakout-region",
				canvasWidth,
				canvasHeight,
				transformHash(transform),
				resolved.cropTop,
			].join(":"),
			width: canvasWidth,
			height: canvasHeight,
			draw: (ctx) => {
				const safeCropTop = Math.max(0, Math.min(0.95, resolved.cropTop));
				const { canvas: localMask, context: localContext } =
					createCanvasSurface({
						width: Math.max(1, Math.round(transform.width)),
						height: Math.max(1, Math.round(transform.height)),
					});
				localContext.fillStyle = "white";
				localContext.fillRect(
					0,
					0,
					transform.width,
					Math.min(transform.height, transform.height * safeCropTop + 2),
				);
				drawTransformedCanvas({
					ctx,
					source: localMask,
					transform,
				});
			},
		});
		const foregroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
			type: "layer",
			textureId: sourceTextureId,
			transform,
			opacity: resolved.sourceOpacity,
			blendMode: resolved.blendMode,
			effectPassGroups: resolved.effectPassGroups,
			sourceMask: { textureId: matteTextureId, inverted: false },
			mask: {
				textureId: breakoutMaskTextureId,
				feather: 0,
				inverted: false,
			},
		};
		setCameraLayerMetadata({
			layer: foregroundLayer,
			depth: resolved.cameraDepth,
			locked: resolved.cameraLocked,
		});
		groupItems.push(foregroundLayer);
	}
	items.push({
		type: "group",
		items: groupItems,
		opacity: resolved.opacity,
		blendMode: "normal",
	});
}

function collectPersonCutoutLayer({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: PersonCutoutLayerNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const resolved = node.resolved;
	if (!resolved || resolved.opacity <= 0) return;
	const { width: canvasWidth, height: canvasHeight } = renderer;
	const groupItems: Array<Extract<FrameItemDescriptor, { type: "layer" }>> = [];
	const existingSourceTexture = [...textures.values()].find(
		(texture) =>
			texture.kind === "external" && texture.source === resolved.source,
	);
	const sourceTextureId = existingSourceTexture?.id ?? `${path}:cutout-source`;
	if (!existingSourceTexture) {
		textures.set(sourceTextureId, {
			kind: "external",
			id: sourceTextureId,
			source: resolved.source,
			width: resolved.sourceWidth,
			height: resolved.sourceHeight,
		});
	}

	const containScale = Math.min(
		canvasWidth / resolved.sourceWidth,
		canvasHeight / resolved.sourceHeight,
	);
	const scaledWidth =
		resolved.sourceWidth * containScale * resolved.transform.scaleX;
	const scaledHeight =
		resolved.sourceHeight * containScale * resolved.transform.scaleY;
	const transform: QuadTransformDescriptor = {
		centerX: canvasWidth / 2 + resolved.transform.position.x,
		centerY: canvasHeight / 2 + resolved.transform.position.y,
		width: Math.abs(scaledWidth),
		height: Math.abs(scaledHeight),
		rotationDegrees: resolved.transform.rotate,
		perspectiveXDegrees: resolved.transform.perspectiveX,
		perspectiveYDegrees: resolved.transform.perspectiveY,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
	};

	const maskTextureId = resolved.mask ? `${path}:cutout-matte` : null;
	if (resolved.mask && maskTextureId) {
		textures.set(maskTextureId, {
			kind: "external",
			id: maskTextureId,
			source: resolved.mask.canvas,
			width: resolved.mask.width,
			height: resolved.mask.height,
		});
	}

	if (resolved.backgroundMode !== "remove" && maskTextureId) {
		const backgroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
			type: "layer",
			textureId: sourceTextureId,
			transform,
			opacity: resolved.sourceOpacity,
			blendMode: resolved.blendMode,
			effectPassGroups: [
				...resolved.backgroundEffectPasses,
				...resolved.effectPassGroups,
			],
			sourceMask: { textureId: maskTextureId, inverted: true },
			mask: null,
		};
		setCameraLayerMetadata({
			layer: backgroundLayer,
			depth: resolved.cameraDepth,
			locked: resolved.cameraLocked,
		});
		groupItems.push(backgroundLayer);
	}

	const foregroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
		type: "layer",
		textureId: sourceTextureId,
		transform,
		opacity: resolved.sourceOpacity,
		blendMode: resolved.blendMode,
		effectPassGroups: resolved.effectPassGroups,
		sourceMask: maskTextureId
			? { textureId: maskTextureId, inverted: false }
			: null,
		mask: null,
	};
	setCameraLayerMetadata({
		layer: foregroundLayer,
		depth: resolved.cameraDepth,
		locked: resolved.cameraLocked,
	});
	groupItems.push(foregroundLayer);

	items.push({
		type: "group",
		items: groupItems,
		opacity: resolved.opacity,
		blendMode: "normal",
	});
}

function isAnimatedBackgroundStyle(style: string): boolean {
	switch (style) {
		case "grid-waves":
		case "waves":
		case "snow-screen":
		case "retro-film":
		case "aurora":
		case "bokeh":
		case "snowfall":
		case "pixel-rain":
		case "vhs-bars":
		case "film-burn":
		case "dust":
		case "scratches":
		case "rain":
		case "embers":
		case "smoke":
			return true;
		default:
			return false;
	}
}

function applyOverlayMovementToCollectedLayers({
	movement,
	renderer,
	cameraWidth,
	cameraHeight,
	items,
}: {
	movement: OverlayMovementFrame;
	renderer: RendererSize;
	cameraWidth?: number;
	cameraHeight?: number;
	items: FrameItemDescriptor[];
}) {
	for (const item of items) {
		if (item.type === "group") {
			applyOverlayMovementToCollectedLayers({
				movement,
				renderer,
				cameraWidth,
				cameraHeight,
				items: item.items,
			});
			continue;
		}
		if (item.type !== "layer") continue;
		const metadata = getCameraLayerMetadata(item);
		if (metadata.locked) continue;
		const depthFactor =
			metadata.motionFactor ??
			resolveCameraDepthFactor({
				depth: metadata.depth,
				parallaxStrength: movement.parallaxStrength,
			});
		const translationFactor = metadata.motionFactor ?? depthFactor;
		const scaleFactor =
			metadata.motionFactor === undefined
				? depthFactor
				: Math.abs(metadata.motionFactor);
		item.transform = transformQuad({
			transform: item.transform,
			movement,
			cameraWidth: cameraWidth ?? renderer.width,
			cameraHeight: cameraHeight ?? renderer.height,
			depthFactor: scaleFactor,
			translationFactor,
		});
	}
}

function transformQuad({
	transform,
	movement,
	cameraWidth,
	cameraHeight,
	depthFactor,
	translationFactor,
}: {
	transform: QuadTransformDescriptor;
	movement: OverlayMovementFrame;
	cameraWidth: number;
	cameraHeight: number;
	depthFactor: number;
	translationFactor: number;
}): QuadTransformDescriptor {
	const effectiveScale = Math.max(0.01, 1 + (movement.scale - 1) * depthFactor);
	const effectiveRotate = movement.rotate * depthFactor;
	const originX = cameraWidth / 2;
	const originY = cameraHeight / 2;
	const offsetX = (transform.centerX - originX) * effectiveScale;
	const offsetY = (transform.centerY - originY) * effectiveScale;
	const radians = (effectiveRotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	return {
		...transform,
		centerX:
			originX +
			offsetX * cos -
			offsetY * sin +
			movement.translateX * translationFactor,
		centerY:
			originY +
			offsetX * sin +
			offsetY * cos +
			movement.translateY * translationFactor,
		width: transform.width * effectiveScale,
		height: transform.height * effectiveScale,
		rotationDegrees: transform.rotationDegrees + effectiveRotate,
	};
}

function applyParallaxMotionLoopToCollectedLayers({
	motionLoop,
	cameraWidth,
	cameraHeight,
	items,
}: {
	motionLoop: import("@/parallax-story-teller/motion-loop").ParallaxMotionLoopFrame;
	cameraWidth: number;
	cameraHeight: number;
	items: FrameItemDescriptor[];
}) {
	for (const item of items) {
		if (item.type === "group") {
			applyParallaxMotionLoopToCollectedLayers({
				motionLoop,
				cameraWidth,
				cameraHeight,
				items: item.items,
			});
			continue;
		}
		if (item.type !== "layer") continue;
		item.transform = transformParallaxStoryQuad({
			transform: item.transform,
			motionLoop,
			cameraWidth,
			cameraHeight,
		});
	}
}

function transformParallaxStoryQuad({
	transform,
	motionLoop,
	cameraWidth,
	cameraHeight,
}: {
	transform: QuadTransformDescriptor;
	motionLoop: import("@/parallax-story-teller/motion-loop").ParallaxMotionLoopFrame;
	cameraWidth: number;
	cameraHeight: number;
}): QuadTransformDescriptor {
	const scale = Math.max(0.01, motionLoop.scale * motionLoop.safeScale);
	const originX = cameraWidth / 2;
	const originY = cameraHeight / 2;
	const offsetX = (transform.centerX - originX) * scale;
	const offsetY = (transform.centerY - originY) * scale;
	const radians = (motionLoop.rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	return {
		...transform,
		centerX: originX + offsetX * cos - offsetY * sin + motionLoop.translateX,
		centerY: originY + offsetX * sin + offsetY * cos + motionLoop.translateY,
		width: transform.width * scale,
		height: transform.height * scale,
		rotationDegrees: transform.rotationDegrees + motionLoop.rotate,
	};
}

function collectOverlayMovementFlash({
	movement,
	renderer,
	path,
	items,
	textures,
}: {
	movement: OverlayMovementFrame;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const textureId = `${path}:overlay-movement-flash`;
	const { width, height } = renderer;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `overlay-movement-flash:${width}x${height}:${movement.presetId}:${movement.flashAlpha}`,
		width,
		height,
		draw: (ctx) => {
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, width, height);
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform({ renderer }),
		opacity: movement.flashAlpha,
		blendMode: "screen",
		effectPassGroups: [],
		mask: null,
	});
}

function collectOverlayMovementVisuals({
	movement,
	renderer,
	path,
	items,
	textures,
}: {
	movement: OverlayMovementFrame;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const textureId = `${path}:overlay-movement-visuals`;
	const { width, height } = renderer;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `overlay-movement-visuals:${width}x${height}:${movement.presetId}:${movement.overlayColor ?? ""}:${movement.overlayAlpha}:${movement.vignetteAlpha}`,
		width,
		height,
		draw: (ctx) => {
			if (movement.overlayColor && movement.overlayAlpha > 0) {
				ctx.save();
				ctx.globalAlpha = movement.overlayAlpha;
				ctx.fillStyle = movement.overlayColor;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
			if (movement.vignetteAlpha > 0) {
				const radius = Math.max(width, height) * 0.72;
				const vignette = ctx.createRadialGradient(
					width / 2,
					height / 2,
					Math.min(width, height) * 0.16,
					width / 2,
					height / 2,
					radius,
				);
				vignette.addColorStop(0, "rgba(0,0,0,0)");
				vignette.addColorStop(
					0.62,
					`rgba(0,0,0,${movement.vignetteAlpha * 0.28})`,
				);
				vignette.addColorStop(1, `rgba(0,0,0,${movement.vignetteAlpha})`);
				ctx.fillStyle = vignette;
				ctx.fillRect(0, 0, width, height);
			}
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform({ renderer }),
		opacity: 1,
		blendMode: movement.overlayBlendMode,
		effectPassGroups: [],
		mask: null,
	});
}

function collectEffectVisualOverlay({
	visualOverlay,
	renderer,
	path,
	items,
	textures,
}: {
	visualOverlay: EffectLayerVisualOverlay;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const textureId = `${path}:effect-visual-overlay`;
	const { width, height } = renderer;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `effect-visual-overlay:${width}x${height}:${JSON.stringify(visualOverlay)}`,
		width,
		height,
		draw: (ctx) => {
			drawEffectLayerVisualOverlay({
				ctx,
				overlay: visualOverlay,
				width,
				height,
			});
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform({ renderer }),
		opacity: visualOverlay.opacity,
		blendMode: visualOverlay.blendMode,
		effectPassGroups: [],
		mask: null,
	});
}

function collectAiEffectOverlay({
	overlay,
	renderer,
	path,
	items,
	textures,
}: {
	overlay: EffectLayerOverlay;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	const textureId = `${path}:ai-effect-overlay`;
	const { width, height } = renderer;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `ai-effect-overlay:${width}x${height}:${overlay.label}:${overlay.intent ?? ""}`,
		width,
		height,
		draw: (ctx) => {
			drawAiEffectOverlay({ ctx, overlay, width, height });
		},
	});
	items.push({
		type: "layer",
		textureId,
		transform: fullCanvasTransform({ renderer }),
		opacity: 1,
		blendMode: "normal",
		effectPassGroups: [],
		mask: null,
	});
}

function drawAiEffectOverlay({
	ctx,
	overlay,
	width,
	height,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	overlay: EffectLayerOverlay;
	width: number;
	height: number;
}) {
	const scale = Math.max(0.75, Math.min(width / 1280, 1.4));
	const paddingX = 14 * scale;
	const paddingY = 10 * scale;
	const x = 24 * scale;
	const y = height - 78 * scale;
	const maxTextWidth = Math.min(width * 0.58, 520 * scale);
	const title = truncateText({
		text: `AI edit: ${overlay.label}`,
		maxCharacters: 64,
	});
	const subtitle = overlay.intent
		? truncateText({ text: overlay.intent, maxCharacters: 82 })
		: "";
	const titleSize = 15 * scale;
	const subtitleSize = 11 * scale;
	const boxWidth = Math.min(width - x * 2, maxTextWidth + paddingX * 2);
	const boxHeight =
		paddingY * 2 + titleSize + (subtitle ? subtitleSize + 7 * scale : 0);

	ctx.save();
	ctx.font = `600 ${titleSize}px Inter, Arial, sans-serif`;
	ctx.textBaseline = "top";
	ctx.fillStyle = "rgba(17, 17, 29, 0.76)";
	ctx.strokeStyle = "rgba(154, 119, 255, 0.88)";
	ctx.lineWidth = Math.max(1, 1.5 * scale);
	ctx.beginPath();
	ctx.roundRect(x, y, boxWidth, boxHeight, 8 * scale);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = "#f4f0ff";
	ctx.fillText(title, x + paddingX, y + paddingY, maxTextWidth);
	if (subtitle) {
		ctx.font = `400 ${subtitleSize}px Inter, Arial, sans-serif`;
		ctx.fillStyle = "rgba(244, 240, 255, 0.72)";
		ctx.fillText(
			subtitle,
			x + paddingX,
			y + paddingY + titleSize + 7 * scale,
			maxTextWidth,
		);
	}
	ctx.restore();
}

function truncateText({
	text,
	maxCharacters,
}: {
	text: string;
	maxCharacters: number;
}): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxCharacters) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}

async function collectVisualSourceNode({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	if (!node.resolved) {
		return;
	}

	const source =
		node instanceof GraphicNode
			? node.getSource({
					resolvedParams: node.resolved.resolvedParams,
					localTime: node.resolved.localTime,
				})
			: node.resolved.source;
	if (!source) {
		return;
	}

	const sourceWidth =
		node instanceof GraphicNode
			? (node.resolved as ResolvedGraphicNodeState).sourceWidth
			: (node.resolved as ResolvedVisualSourceNodeState).sourceWidth;
	const sourceHeight =
		node instanceof GraphicNode
			? (node.resolved as ResolvedGraphicNodeState).sourceHeight
			: (node.resolved as ResolvedVisualSourceNodeState).sourceHeight;

	const textureId = `${path}:source`;
	textures.set(textureId, {
		kind: "external",
		id: textureId,
		source,
		width: sourceWidth,
		height: sourceHeight,
		...(node instanceof GraphicNode
			? { previewScaleMode: "frame" as const }
			: {}),
	});
	const backgroundRemoval =
		node instanceof VideoNode ? node.resolved.backgroundRemoval : undefined;
	const sourceMaskTextureId = backgroundRemoval
		? `${path}:background-removal-mask`
		: null;
	if (backgroundRemoval && sourceMaskTextureId) {
		textures.set(sourceMaskTextureId, {
			kind: "external",
			id: sourceMaskTextureId,
			source: backgroundRemoval.mask.canvas,
			width: backgroundRemoval.mask.width,
			height: backgroundRemoval.mask.height,
		});
	}

	const transform = computeVisualTransform({
		renderer,
		resolved: node.resolved,
		sourceWidth,
		sourceHeight,
		cameraWidth: node.params.cameraCanvasWidth,
		cameraHeight: node.params.cameraCanvasHeight,
		layoutSize:
			node instanceof GraphicNode
				? getGraphicLayoutSize({
						definitionId: node.params.definitionId,
						params: node.resolved.resolvedParams,
					})
				: null,
		fitSourceSize:
			node instanceof GraphicNode &&
			!getGraphicLayoutSize({
				definitionId: node.params.definitionId,
				params: node.resolved.resolvedParams,
			})
				? getGraphicDefinition({
						definitionId: node.params.definitionId,
					}).sourceSize?.({ params: node.resolved.resolvedParams })
				: null,
		fitMode: node instanceof VideoNode ? node.params.fitMode : "contain",
	});
	const { mask, strokeLayer } = buildMaskArtifacts({
		node,
		renderer,
		path,
		transform,
		textures,
	});

	if (
		backgroundRemoval &&
		sourceMaskTextureId &&
		backgroundRemoval.settings.mode !== "remove"
	) {
		const backgroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
			type: "layer",
			textureId,
			transform,
			opacity: node.resolved.opacity,
			blendMode: node.params.blendMode ?? "normal",
			effectPassGroups: [
				...backgroundRemoval.backgroundEffectPasses,
				...node.resolved.effectPasses,
			],
			sourceMask: { textureId: sourceMaskTextureId, inverted: true },
			mask,
		};
		setCameraLayerMetadataFromNode({ layer: backgroundLayer, node });
		items.push(backgroundLayer);
	}

	const foregroundLayer: Extract<FrameItemDescriptor, { type: "layer" }> = {
		type: "layer",
		textureId,
		transform,
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: node.resolved.effectPasses,
		sourceMask:
			backgroundRemoval && sourceMaskTextureId
				? { textureId: sourceMaskTextureId, inverted: false }
				: null,
		mask,
	};
	setCameraLayerMetadataFromNode({ layer: foregroundLayer, node });
	items.push(foregroundLayer);
	if (strokeLayer?.type === "layer") {
		setCameraLayerMetadataFromNode({ layer: strokeLayer, node });
		items.push(strokeLayer);
	}
}

function collectTextNode({
	node,
	renderer,
	path,
	items,
	textures,
}: {
	node: TextNode;
	renderer: RendererSize;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
}) {
	if (!node.resolved) {
		return;
	}

	const textureId = `${path}:text`;
	const width = node.params.worldPinned
		? (node.params.cameraCanvasWidth ?? renderer.width)
		: renderer.width;
	const height = node.params.worldPinned
		? (node.params.cameraCanvasHeight ?? renderer.height)
		: renderer.height;
	// Text output is fully determined by node.params + node.resolved. Both are
	// plain data we can stringify cheaply; the resolved measured layout is the
	// expensive part of text setup, so stringifying it here is orders of
	// magnitude cheaper than re-rasterizing when nothing changed.
	const contentHash = `text:${width}x${height}:${JSON.stringify({
		params: node.params,
		resolved: node.resolved,
	})}`;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash,
		width,
		height,
		draw: (ctx) => {
			renderTextToContext({
				node,
				ctx,
				omitWorldPosition: node.params.worldPinned,
			});
		},
	});
	const transform = node.params.worldPinned
		? {
				centerX:
					node.params.canvasCenter.x + node.resolved.transform.position.x,
				centerY:
					node.params.canvasCenter.y + node.resolved.transform.position.y,
				width,
				height,
				rotationDegrees: 0,
				perspectiveXDegrees: node.resolved.transform.perspectiveX,
				perspectiveYDegrees: node.resolved.transform.perspectiveY,
				flipX: false,
				flipY: false,
			}
		: fullCanvasTransform({
				renderer,
				perspective: node.resolved.transform,
			});
	const layer: Extract<FrameItemDescriptor, { type: "layer" }> = {
		type: "layer",
		textureId,
		transform,
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: node.resolved.effectPasses,
		mask: null,
	};
	setCameraLayerMetadataFromNode({ layer, node });
	items.push(layer);
}

function setCameraLayerMetadataFromNode({
	layer,
	node,
}: {
	layer: Extract<FrameItemDescriptor, { type: "layer" }>;
	node: VideoNode | ImageNode | StickerNode | GraphicNode | TextNode;
}) {
	setCameraLayerMetadata({
		layer,
		depth: node.params.cameraDepth ?? 1,
		locked: node.params.cameraLocked ?? false,
		motionFactor: node.params.cameraMotionFactor,
	});
}

function setCameraLayerMetadata({
	layer,
	depth,
	locked,
	motionFactor,
}: {
	layer: Extract<FrameItemDescriptor, { type: "layer" }>;
	depth: number;
	locked: boolean;
	motionFactor?: number;
}) {
	(layer as CameraAwareLayer)[Symbol.for("opencut-camera-layer-metadata")] = {
		depth,
		locked,
		motionFactor,
	};
}

function getCameraLayerMetadata(
	layer: Extract<FrameItemDescriptor, { type: "layer" }>,
): CameraLayerMetadata {
	return (
		(layer as CameraAwareLayer)[
			Symbol.for("opencut-camera-layer-metadata")
		] ?? {
			depth: 1,
			locked: false,
		}
	);
}

function computeVisualTransform({
	renderer,
	resolved,
	sourceWidth,
	sourceHeight,
	cameraWidth,
	cameraHeight,
	layoutSize,
	fitSourceSize,
	fitMode = "contain",
}: {
	renderer: RendererSize;
	resolved: ResolvedVisualSourceNodeState | ResolvedGraphicNodeState;
	sourceWidth: number;
	sourceHeight: number;
	cameraWidth?: number;
	cameraHeight?: number;
	layoutSize?: { width: number; height: number } | null;
	fitSourceSize?: { width: number; height: number } | null;
	fitMode?: VisualFitMode;
}): QuadTransformDescriptor {
	const layoutWidth = cameraWidth ?? renderer.width;
	const layoutHeight = cameraHeight ?? renderer.height;
	const containScale = layoutSize
		? 1
		: resolveVisualFitScale({
				containerWidth: layoutWidth,
				containerHeight: layoutHeight,
				sourceWidth: fitSourceSize?.width ?? sourceWidth,
				sourceHeight: fitSourceSize?.height ?? sourceHeight,
				fitMode,
			});
	const scaledWidth =
		(layoutSize?.width ?? fitSourceSize?.width ?? sourceWidth) *
		containScale *
		resolved.transform.scaleX;
	const scaledHeight =
		(layoutSize?.height ?? fitSourceSize?.height ?? sourceHeight) *
		containScale *
		resolved.transform.scaleY;
	const absWidth = Math.abs(scaledWidth);
	const absHeight = Math.abs(scaledHeight);

	return {
		centerX: layoutWidth / 2 + resolved.transform.position.x,
		centerY: layoutHeight / 2 + resolved.transform.position.y,
		width: absWidth,
		height: absHeight,
		rotationDegrees: resolved.transform.rotate,
		perspectiveXDegrees: resolved.transform.perspectiveX,
		perspectiveYDegrees: resolved.transform.perspectiveY,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
	};
}

function fullCanvasTransform({
	renderer,
	perspective,
}: {
	renderer: RendererSize;
	perspective?: { perspectiveX: number; perspectiveY: number };
}): QuadTransformDescriptor {
	return {
		centerX: renderer.width / 2,
		centerY: renderer.height / 2,
		width: renderer.width,
		height: renderer.height,
		rotationDegrees: 0,
		perspectiveXDegrees: perspective?.perspectiveX ?? 0,
		perspectiveYDegrees: perspective?.perspectiveY ?? 0,
		flipX: false,
		flipY: false,
	};
}

function buildMaskArtifacts({
	node,
	renderer,
	path,
	transform,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: RendererSize;
	path: string;
	transform: QuadTransformDescriptor;
	textures: Map<string, TextureUploadDescriptor>;
}): {
	mask: LayerMaskDescriptor | null;
	strokeLayer: FrameItemDescriptor | null;
} {
	const mask = node.params.masks?.[0];
	if (!mask) {
		return { mask: null, strokeLayer: null };
	}

	const definition = getMaskDefinition(mask.type);

	if (definition.isActive?.(mask.params) === false) {
		return { mask: null, strokeLayer: null };
	}

	const { body } = definition.renderer;
	const usesOpaqueFastPath =
		body.kind === "drawWithFeather" &&
		mask.params.feather === 0 &&
		Boolean(body.opaqueFastPath);
	// drawWithFeather renderers encode feathering analytically in their canvas output
	// (e.g. split mask uses a linear gradient instead of JFA). The descriptor feather is
	// zeroed so the GPU compositor copies the mask texture as-is and does not run a second
	// JFA feather pass on top of an already-soft texture.
	const feather = body.kind === "drawWithFeather" ? 0 : mask.params.feather;

	const maskTextureId = `${path}:mask`;
	const { width: canvasWidth, height: canvasHeight } = renderer;
	const maskContentHash = `mask:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:body=${body.kind}:fastPath=${usesOpaqueFastPath}`;
	const drawMask: TextureCanvasDrawFn = (ctx) => {
		const { canvas: elementMaskCanvas, context: elementMaskCtx } =
			createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

		switch (body.kind) {
			case "fillPath": {
				const path2d = body.buildPath({
					resolvedParams: mask.params,
					width: transform.width,
					height: transform.height,
				});
				elementMaskCtx.fillStyle = "white";
				elementMaskCtx.fill(path2d);
				break;
			}
			case "drawOpaque":
				body.drawOpaque({
					resolvedParams: mask.params,
					ctx: elementMaskCtx,
					width: Math.round(transform.width),
					height: Math.round(transform.height),
				});
				break;
			case "drawWithFeather":
				if (usesOpaqueFastPath && body.opaqueFastPath) {
					const path2d = body.opaqueFastPath.buildPath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					elementMaskCtx.fillStyle = "white";
					elementMaskCtx.fill(path2d);
				} else {
					body.drawWithFeather({
						resolvedParams: mask.params,
						ctx: elementMaskCtx,
						width: Math.round(transform.width),
						height: Math.round(transform.height),
						feather: mask.params.feather,
					});
				}
				break;
		}

		drawTransformedCanvas({ ctx, source: elementMaskCanvas, transform });
	};
	textures.set(maskTextureId, {
		kind: "rendered",
		id: maskTextureId,
		contentHash: maskContentHash,
		width: canvasWidth,
		height: canvasHeight,
		draw: drawMask,
	});

	const stroke = definition.renderer.stroke;
	const hasStroke = mask.params.strokeWidth > 0 && Boolean(stroke);
	let strokeLayer: FrameItemDescriptor | null = null;
	if (hasStroke && stroke) {
		const strokeTextureId = `${path}:mask-stroke`;
		const strokeContentHash = `stroke:${mask.type}:${JSON.stringify(mask.params)}:${transformHash(transform)}:${canvasWidth}x${canvasHeight}:stroke=${stroke.kind}`;
		const drawStroke: TextureCanvasDrawFn = (ctx) => {
			const { canvas: strokeCanvas, context: strokeCtx } = createCanvasSurface({
				width: Math.round(transform.width),
				height: Math.round(transform.height),
			});

			switch (stroke.kind) {
				case "renderStroke":
					stroke.renderStroke({
						resolvedParams: mask.params,
						ctx: strokeCtx,
						width: transform.width,
						height: transform.height,
					});
					break;
				case "strokeFromPath": {
					const strokePath = stroke.buildStrokePath({
						resolvedParams: mask.params,
						width: transform.width,
						height: transform.height,
					});
					strokeCtx.strokeStyle = mask.params.strokeColor;
					strokeCtx.lineWidth = mask.params.strokeWidth;
					strokeCtx.stroke(strokePath);
					break;
				}
			}

			drawTransformedCanvas({ ctx, source: strokeCanvas, transform });
		};
		textures.set(strokeTextureId, {
			kind: "rendered",
			id: strokeTextureId,
			contentHash: strokeContentHash,
			width: canvasWidth,
			height: canvasHeight,
			draw: drawStroke,
		});
		strokeLayer = {
			type: "layer",
			textureId: strokeTextureId,
			transform: fullCanvasTransform({ renderer }),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		};
	}

	return {
		mask: {
			textureId: maskTextureId,
			feather,
			inverted: mask.params.inverted,
		},
		strokeLayer,
	};
}

function drawTransformedCanvas({
	ctx,
	source,
	transform,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	source: CanvasImageSource;
	transform: QuadTransformDescriptor;
}) {
	const x = transform.centerX - transform.width / 2;
	const y = transform.centerY - transform.height / 2;
	const flipX = transform.flipX ? -1 : 1;
	const flipY = transform.flipY ? -1 : 1;
	const requiresTransform =
		transform.rotationDegrees !== 0 || flipX !== 1 || flipY !== 1;

	ctx.save();
	if (requiresTransform) {
		ctx.translate(transform.centerX, transform.centerY);
		ctx.rotate((transform.rotationDegrees * Math.PI) / 180);
		ctx.scale(flipX, flipY);
		ctx.translate(-transform.centerX, -transform.centerY);
	}
	ctx.drawImage(source, x, y, transform.width, transform.height);
	ctx.restore();
}

function transformHash(transform: QuadTransformDescriptor): string {
	return `${transform.centerX}:${transform.centerY}:${transform.width}:${transform.height}:${transform.rotationDegrees}:${transform.flipX ? 1 : 0}:${transform.flipY ? 1 : 0}`;
}

// Stable identity key for CanvasImageSource. Using a WeakMap → counter keeps
// hash string length bounded and avoids holding sources alive.
const identityKeys = new WeakMap<object, number>();
let nextIdentity = 1;
function identityKey(source: CanvasImageSource): string {
	if (typeof source === "object" && source !== null) {
		let key = identityKeys.get(source);
		if (key === undefined) {
			key = nextIdentity++;
			identityKeys.set(source, key);
		}
		return `@${key}`;
	}
	return "@?";
}
