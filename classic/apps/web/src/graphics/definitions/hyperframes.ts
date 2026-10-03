import type { GraphicDefinition } from "../types";

/** Full source compositions are imported through the canonical runtime. Their
 * actual frame source is supplied by the scene builder; this definition also
 * provides ordinary Classic bounds, inspector and thumbnail integration.
 */
export const hyperframesGraphicDefinition: GraphicDefinition = {
	id: "hyperframes",
	name: "HyperFrames composition",
	keywords: ["composition", "animation", "hyperframes"],
	params: [],
	sourceSize({ params }) {
		return {
			width:
				typeof params.sourceWidth === "number" && params.sourceWidth > 0
					? params.sourceWidth
					: 512,
			height:
				typeof params.sourceHeight === "number" && params.sourceHeight > 0
					? params.sourceHeight
					: 512,
		};
	},
	render({ ctx, width, height }) {
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "#8b5cf6";
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = "#ffffff";
		ctx.font = `${Math.max(12, width / 9)}px sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText("HyperFrames", width / 2, height / 2, width * 0.9);
	},
};
