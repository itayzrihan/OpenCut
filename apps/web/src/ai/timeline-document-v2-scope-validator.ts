import * as OpenCutWasm from "opencut-wasm";
import type { TimelineDocumentV2MutationScopeValidator } from "./timeline-document-v2-scope";

/** Statically analyzable production binding; tests inject a narrow validator. */
export const defaultTimelineDocumentV2MutationScopeValidator = (
	OpenCutWasm as unknown as {
		validateTimelineSourceV2MutationScope?: TimelineDocumentV2MutationScopeValidator;
	}
).validateTimelineSourceV2MutationScope;
