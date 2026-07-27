import type { ParamDefinition } from "@/params";
import {
	getHyperframeRaster,
	prepareHyperframeRaster,
} from "../html-raster";
import type { GraphicDefinition } from "../types";

export const HYPERFRAME_DEFINITION_ID = "hyperframe";
export const DEFAULT_HYPERFRAME_WIDTH = 1920;
export const DEFAULT_HYPERFRAME_HEIGHT = 1080;
const MIN_HYPERFRAME_SIZE = 16;
const MAX_HYPERFRAME_SIZE = 4096;

const HYPERFRAME_PARAMS: ParamDefinition[] = [
	{
		key: "html",
		label: "HTML",
		type: "text",
		default: "",
		keyframable: false,
	},
	{
		key: "sourceWidth",
		label: "Source Width",
		type: "number",
		default: DEFAULT_HYPERFRAME_WIDTH,
		min: MIN_HYPERFRAME_SIZE,
		max: MAX_HYPERFRAME_SIZE,
		step: 1,
		keyframable: false,
	},
	{
		key: "sourceHeight",
		label: "Source Height",
		type: "number",
		default: DEFAULT_HYPERFRAME_HEIGHT,
		min: MIN_HYPERFRAME_SIZE,
		max: MAX_HYPERFRAME_SIZE,
		step: 1,
		keyframable: false,
	},
];

function readHyperframeSize(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(
		MAX_HYPERFRAME_SIZE,
		Math.max(MIN_HYPERFRAME_SIZE, Math.round(parsed)),
	);
}

export const hyperframeGraphicDefinition: GraphicDefinition = {
	id: HYPERFRAME_DEFINITION_ID,
	name: "HTML Frame",
	keywords: ["html", "hyperframe", "ai", "motion", "custom"],
	params: HYPERFRAME_PARAMS,
	sourceSize({ params }) {
		return {
			width: readHyperframeSize(params.sourceWidth, DEFAULT_HYPERFRAME_WIDTH),
			height: readHyperframeSize(
				params.sourceHeight,
				DEFAULT_HYPERFRAME_HEIGHT,
			),
		};
	},
	async prepare({ params, width, height, localTime, duration }) {
		const html = typeof params.html === "string" ? params.html : "";
		if (!html.trim()) {
			return;
		}
		await prepareHyperframeRaster({
			html,
			width,
			height,
			timeSeconds: localTime ?? 0,
			durationSeconds: duration ?? 0,
		});
	},
	render({ ctx, params, width, height, localTime, duration }) {
		ctx.clearRect(0, 0, width, height);
		const html = typeof params.html === "string" ? params.html : "";
		if (!html.trim()) {
			return;
		}
		const raster = getHyperframeRaster({
			html,
			width,
			height,
			timeSeconds: localTime ?? 0,
			durationSeconds: duration ?? 0,
		});
		if (!raster) {
			return;
		}
		ctx.drawImage(raster, 0, 0, width, height);
	},
};
