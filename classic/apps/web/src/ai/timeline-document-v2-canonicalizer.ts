import * as OpenCutWasm from "opencut-wasm";
import type { TimelineDocumentV2Canonicalizer } from "./timeline-document-v2";

/** Statically analyzable production binding; tests replace this local provider. */
export const defaultTimelineDocumentV2Canonicalizer = (
	OpenCutWasm as unknown as {
		canonicalizeTimelineSourceDocument?: TimelineDocumentV2Canonicalizer;
	}
).canonicalizeTimelineSourceDocument;
