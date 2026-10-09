import { createCanvasSurface } from "../canvas-utils";
import { markCanvasSourceVersion } from "../canvas-source-version";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	getGraphicLayoutSize,
	getGraphicDefinition,
	registerDefaultGraphics,
} from "@/graphics";
import type { ParamValues } from "@/params";
import type { HyperframesLiveHandle } from "@/hyperframes/types";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface GraphicNodeParams extends VisualNodeParams {
	definitionId: string;
	params: ParamValues;
	/** Enables derived capture scaling only in the interactive preview. */
	isPreview?: boolean;
	/** Host rendering dependency, never serialized in the editor document. */
	frameSource?: {
		width: number;
		height: number;
		getResourceRevision: () => number;
		live?: {
			/** Canonical clip identity keeps repeated uses independently seekable. */
			occurrenceId: string;
			/** Stable source identity across canonical clip/transform edits. */
			key: object;
			open: () => Promise<HyperframesLiveHandle>;
			getSourceTime: (localTime: number) => number;
		};
		renderTo: (input: {
			localTime: number;
			target: OffscreenCanvas;
			previewScale: number;
		}) => Promise<void>;
	};
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
	private externalTime: number | null = null;
	private externalRevision: number | null = null;
	private externalScale: number | null = null;

	constructor(params: GraphicNodeParams) {
		super(params);
		registerDefaultGraphics();
	}

	getSourceSize({
		resolvedParams,
	}: {
		resolvedParams?: ParamValues;
	} = {}): { width: number; height: number } {
		if (this.params.frameSource)
			return {
				width: this.params.frameSource.width,
				height: this.params.frameSource.height,
			};
		const definition = getGraphicDefinition({
			definitionId: this.params.definitionId,
		});
		const params = resolvedParams ?? this.params.params;
		if (!definition.sourceSize) {
			return {
				width: DEFAULT_GRAPHIC_SOURCE_SIZE,
				height: DEFAULT_GRAPHIC_SOURCE_SIZE,
			};
		}
		const sourceSize = definition.sourceSize({ params });
		if (
			definition.resizeBehavior !== "dimensions" ||
			getGraphicLayoutSize({
				definitionId: this.params.definitionId,
				params,
			})
		) {
			return sourceSize;
		}

		// Legacy procedural backgrounds stored their visual size as transform
		// scale. Render a denser source immediately so old projects stop looking
		// blurry before the first handle resize bakes that scale into dimensions.
		return {
			width: Math.max(
				1,
				Math.round(
					sourceSize.width *
						Math.max(1, Math.abs(this.params.transform.scaleX)),
				),
			),
			height: Math.max(
				1,
				Math.round(
					sourceSize.height *
						Math.max(1, Math.abs(this.params.transform.scaleY)),
				),
			),
		};
	}

	getSource({
		resolvedParams,
		localTime = 0,
	}: {
		resolvedParams: ParamValues;
		localTime?: number;
	}): OffscreenCanvas {
		if (this.params.definitionId === "hyperframes") {
			if (
				!this.params.frameSource ||
				!this.cachedSource ||
				this.externalTime !== localTime ||
				this.externalRevision !== this.params.frameSource.getResourceRevision()
			)
				throw new Error(
					"HyperFrames frame was not prepared for the current project and time",
				);
			return this.cachedSource;
		}
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

	async prepareFrame({
		localTime,
		previewScale = 1,
	}: {
		localTime: number;
		previewScale?: number;
	}): Promise<void> {
		const source = this.params.frameSource;
		if (!source)
			throw new Error("HyperFrames composition source is unavailable");
		const revision = source.getResourceRevision();
		const scale = this.params.isPreview ? previewScale : 1;
		if (
			this.cachedSource &&
			this.externalTime === localTime &&
			this.externalRevision === revision &&
			this.externalScale === scale
		)
			return;
		this.cachedSource ??= createCanvasSurface({
			width: source.width,
			height: source.height,
		}).canvas;
		await source.renderTo({
			localTime,
			target: this.cachedSource,
			previewScale: scale,
		});
		markCanvasSourceVersion({
			source: this.cachedSource,
			version: `${revision}:${localTime}:${scale}`,
		});
		this.externalTime = localTime;
		this.externalRevision = revision;
		this.externalScale = scale;
	}
}
