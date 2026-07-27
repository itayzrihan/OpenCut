import { BaseNode } from "./base-node";
import type { TextElement } from "@/timeline";
import type { EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import { drawMeasuredTextLayout } from "@/text/primitives";
import type { MeasuredTextElement } from "@/text/measure-element";
import type { MediaAsset } from "@/media/types";

export type TextNodeParams = TextElement & {
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	canvasCenter: { x: number; y: number };
	canvasHeight: number;
	textBaseline?: CanvasTextBaseline;
	clipMediaAsset?: MediaAsset;
};

export interface ResolvedTextNodeState {
	transform: Transform;
	opacity: number;
	textColor: string;
	backgroundColor: string;
	effectPasses: EffectPass[][];
	measuredText: MeasuredTextElement;
	clipMediaSource?: CanvasImageSource;
}

export class TextNode extends BaseNode<TextNodeParams, ResolvedTextNodeState> {}

export function renderTextToContext({
	node,
	ctx,
}: {
	node: TextNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	const resolved = node.resolved;
	if (!resolved) {
		return;
	}

	const x = resolved.transform.position.x + node.params.canvasCenter.x;
	const y = resolved.transform.position.y + node.params.canvasCenter.y;
	const baseline = node.params.textBaseline ?? "middle";

	ctx.save();
	ctx.translate(x, y);
	ctx.scale(resolved.transform.scaleX, resolved.transform.scaleY);
	if (resolved.transform.rotate) {
		ctx.rotate((resolved.transform.rotate * Math.PI) / 180);
	}

	const measuredText = resolved.clipMediaSource
		? {
				...resolved.measuredText,
				resolvedBackground: null,
				wordLines: resolved.measuredText.wordLines?.map((line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						background: word.background
							? { ...word.background, enabled: false }
							: undefined,
					})),
				})),
			}
		: resolved.measuredText;
	drawMeasuredTextLayout({
		ctx,
		layout: measuredText,
		textColor: resolved.textColor,
		background: resolved.measuredText.resolvedBackground,
		backgroundColor: resolved.backgroundColor,
		textBaseline: baseline,
	});

	ctx.restore();
	if (resolved.clipMediaSource) {
		ctx.save();
		ctx.globalCompositeOperation = "source-in";
		const source = resolved.clipMediaSource;
		const dimensions = sourceDimensions(source);
		const scale = Math.max(
			ctx.canvas.width / Math.max(1, dimensions.width),
			ctx.canvas.height / Math.max(1, dimensions.height),
		);
		const width = dimensions.width * scale;
		const height = dimensions.height * scale;
		ctx.drawImage(source, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height);
		ctx.restore();
	}
}

function sourceDimensions(source: CanvasImageSource) {
	if (source instanceof HTMLImageElement) {
		return { width: source.naturalWidth, height: source.naturalHeight };
	}
	if (source instanceof HTMLVideoElement) {
		return { width: source.videoWidth, height: source.videoHeight };
	}
	const sized = source as {
		width?: number;
		height?: number;
		displayWidth?: number;
		displayHeight?: number;
	};
	return {
		width: sized.width ?? sized.displayWidth ?? 1,
		height: sized.height ?? sized.displayHeight ?? 1,
	};
}
