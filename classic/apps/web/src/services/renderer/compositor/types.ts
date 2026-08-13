import type { BlendMode } from "@/rendering";
import type { EffectPass } from "@/effects/types";

export type FrameDescriptor = {
	width: number;
	height: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type LayerDescriptor = {
	textureId: string;
	transform: QuadTransformDescriptor;
	opacity: number;
	blendMode: BlendMode;
	effectPassGroups: EffectPass[][];
	sourceMask?: SourceMaskDescriptor | null;
	mask: LayerMaskDescriptor | null;
};

export type FrameItemDescriptor =
	| ({ type: "layer" } & LayerDescriptor)
	| {
			type: "group";
			items: FrameItemDescriptor[];
			opacity: number;
			blendMode: BlendMode;
	  }
	| {
			type: "sceneEffect";
			effect_pass_groups: EffectPass[][];
	  };

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	perspectiveXDegrees: number;
	perspectiveYDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};

export type SourceMaskDescriptor = {
	textureId: string;
	inverted: boolean;
};

export type TextureCanvasDrawFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => void;

/**
 * A layer texture whose pixels come from somewhere outside the renderer —
 * typically a decoded video/image frame or a sticker. Cached by reference
 * identity of the source object.
 */
export type ExternalTextureDescriptor = {
	kind: "external";
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
	/**
	 * Procedural graphics are already authored in logical scene pixels. Preview
	 * rasterization must therefore use the frame scale, even when the graphic is
	 * wider than the visible camera (for example, a parallax world background).
	 */
	previewScaleMode?: "frame";
};

/**
 * A layer texture that the renderer rasterizes from scene state (color fill,
 * text layout, mask shape, blur backdrop). Cached by `contentHash`: when it
 * matches the previous frame's hash for this id, the upload is skipped
 * entirely and the persistent canvas is not even cleared.
 */
export type RenderedTextureDescriptor = {
	kind: "rendered";
	id: string;
	contentHash: string;
	width: number;
	height: number;
	draw: TextureCanvasDrawFn;
};

export type TextureUploadDescriptor =
	| ExternalTextureDescriptor
	| RenderedTextureDescriptor;
