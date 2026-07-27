import * as OpenCutWasm from "opencut-wasm";

/** Statically analyzable production binding; tests replace this local provider. */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the export is runtime-checked before use. */
export const defaultAiEditPlanRecordBuilder = (
	OpenCutWasm as unknown as {
		buildAiEditPlanRecord?: (options: unknown) => unknown;
	}
).buildAiEditPlanRecord;
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */
