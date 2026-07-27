import type { ParamDefinition, ParamValues } from "@/params";

export const DEFAULT_GRAPHIC_SOURCE_SIZE = 512;

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
