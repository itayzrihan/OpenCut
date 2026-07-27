import { createCanvasSurface } from "../canvas-utils";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	getGraphicDefinition,
	registerDefaultGraphics,
} from "@/graphics";
import type { ParamValues } from "@/params";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface GraphicNodeParams extends VisualNodeParams {
	definitionId: string;
	params: ParamValues;
}

export interface ResolvedGraphicNodeState extends ResolvedVisualNodeState {
	resolvedParams: ParamValues;
	localTime: number;
	sourceWidth: number;
	sourceHeight: number;
}

export class GraphicNode extends VisualNode<
	GraphicNodeParams,
	ResolvedGraphicNodeState
> {
	private cachedKey: string | null = null;
	private cachedSource: OffscreenCanvas | null = null;

	constructor(params: GraphicNodeParams) {
		super(params);
		registerDefaultGraphics();
	}

	getSourceSize({
		resolvedParams,
	}: {
		resolvedParams?: ParamValues;
	} = {}): { width: number; height: number } {
		const definition = getGraphicDefinition({
			definitionId: this.params.definitionId,
		});
		if (!definition.sourceSize) {
			return {
				width: DEFAULT_GRAPHIC_SOURCE_SIZE,
				height: DEFAULT_GRAPHIC_SOURCE_SIZE,
			};
		}
		return definition.sourceSize({
			params: resolvedParams ?? this.params.params,
		});
	}

	getSource({
		resolvedParams,
		localTime = 0,
	}: {
		resolvedParams: ParamValues;
		localTime?: number;
	}): OffscreenCanvas {
		const definition = getGraphicDefinition({
			definitionId: this.params.definitionId,
		});
		const { width, height } = this.getSourceSize({ resolvedParams });
		const cacheKey = JSON.stringify({
			definitionId: this.params.definitionId,
			params: resolvedParams,
			width,
			height,
			localTime: Math.round(localTime * 30) / 30,
		});
		if (this.cachedSource && this.cachedKey === cacheKey) {
			return this.cachedSource;
		}

		const { canvas, context } = createCanvasSurface({
			width,
			height,
		});

		definition.render({
			ctx: context,
			params: resolvedParams,
			width,
			height,
			localTime,
			duration: this.params.duration,
		});

		this.cachedKey = cacheKey;
		this.cachedSource = canvas;
		return canvas;
	}
}
