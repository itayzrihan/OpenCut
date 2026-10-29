import type { CreateProceduralAudioElement } from "@/timeline";
import {
	buildDefaultParamValues,
	getBuiltInElementParams,
} from "@/params/registry";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import type { EarshotSpec } from "./types";

export function buildEarshotElement({
	spec,
	name,
	startTime = ZERO_MEDIA_TIME,
}: {
	spec: EarshotSpec;
	name: string;
	startTime?: MediaTime;
}): CreateProceduralAudioElement {
	const duration = mediaTimeFromSeconds({ seconds: spec.duration });
	return {
		type: "audio",
		sourceType: "procedural",
		procedural: structuredClone(spec),
		name,
		startTime,
		duration,
		sourceDuration: duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: buildDefaultParamValues(getBuiltInElementParams({ type: "audio" })),
	};
}
