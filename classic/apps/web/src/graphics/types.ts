import type { ParamDefinition, ParamValues } from "@/params";

export const DEFAULT_GRAPHIC_SOURCE_SIZE = 512;
export const GRAPHIC_LAYOUT_WIDTH_PARAM = "layout.width";
export const GRAPHIC_LAYOUT_HEIGHT_PARAM = "layout.height";
export const GRAPHIC_LAYOUT_PIXEL_SCALE_PARAM = "layout.pixelScale";

export interface GraphicRenderContext {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	params: ParamValues;
	width: number;
	height: number;
	localTime?: number;
	duration?: number;
}

export interface GraphicPrepareContext {
	params: ParamValues;
	width: number;
	height: number;
	localTime?: number;
	duration?: number;
}

export interface GraphicSourceSize {
	width: number;
	height: number;
}

export interface GraphicDefinition {
	id: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	/** Dimension-resizable graphics redraw their source instead of enlarging a cached raster. */
	resizeBehavior?: "scale" | "dimensions";
	/** Intrinsic raster size; defaults to DEFAULT_GRAPHIC_SOURCE_SIZE square. */
	sourceSize?(context: { params: ParamValues }): GraphicSourceSize;
	/** Awaited during renderer resolve so async sources are ready before render(). */
	prepare?(context: GraphicPrepareContext): Promise<void>;
	render(context: GraphicRenderContext): void;
}

export interface GraphicInstance {
	definitionId: string;
	params: ParamValues;
}
