import type { ParamDefinition } from "@/params";
import { TICKS_PER_SECOND } from "@/wasm";
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

function readHyperframeSize({
	value,
	fallback,
}: {
	value: unknown;
	fallback: number;
}): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(
		MAX_HYPERFRAME_SIZE,
		Math.max(MIN_HYPERFRAME_SIZE, Math.round(parsed)),
	);
}

export function getHyperframeTimeSeconds({
	mediaTicks,
}: {
	mediaTicks: number | undefined;
}): number {
	return Math.max(0, mediaTicks ?? 0) / TICKS_PER_SECOND;
}

export const hyperframeGraphicDefinition: GraphicDefinition = {
	id: HYPERFRAME_DEFINITION_ID,
	name: "HTML Frame",
	keywords: ["html", "hyperframe", "ai", "motion", "custom"],
	params: HYPERFRAME_PARAMS,
	sourceSize({ params }) {
		return {
			width: readHyperframeSize({
				value: params.sourceWidth,
				fallback: DEFAULT_HYPERFRAME_WIDTH,
			}),
			height: readHyperframeSize({
				value: params.sourceHeight,
				fallback: DEFAULT_HYPERFRAME_HEIGHT,
			}),
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
			timeSeconds: getHyperframeTimeSeconds({ mediaTicks: localTime }),
			durationSeconds: getHyperframeTimeSeconds({ mediaTicks: duration }),
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
			timeSeconds: getHyperframeTimeSeconds({ mediaTicks: localTime }),
			durationSeconds: getHyperframeTimeSeconds({ mediaTicks: duration }),
		});
		if (!raster) {
			return;
		}
		ctx.drawImage(raster, 0, 0, width, height);
	},
};
