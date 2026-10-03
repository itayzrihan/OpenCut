/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Inspection is validated and returned by the canonical Rust registry. */
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { injectScriptsIntoHtml } from "@hyperframes/core/compiler/html-document";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { HyperframesInspection, HyperframesSource } from "./types";

/** Version is pinned with the player in package.json and bun.lock. */
export const HYPERFRAMES_RUNTIME_VERSION = "0.8.115";

/** Prepare a derived document for the persistent preview runtime.
 * The official runtime loads nested hosts from the isolated package origin.
 * Keep author scripts at their original positions: combining a head library
 * and a body script can run scene construction before its DOM exists. Serving
 * the original entry URL also preserves dynamic fetches and module imports.
 * Source files remain unchanged in the canonical document and project store.
 */
export function prepareHyperframesPreview({
	source,
	runtime,
	signal,
}: {
	source: HyperframesSource;
	runtime: CanonicalEditorRuntime;
	signal?: AbortSignal;
}): { html: string; inspection: HyperframesInspection } {
	signal?.throwIfAborted();
	const receipt = runtime.invokeSync(
		"hyperframes.project.inspect",
		{ source },
		undefined,
	) as { result: { data: HyperframesInspection } };
	const html = injectScriptsIntoHtml(
		source.files[source.entryFile],
		[getHyperframeRuntimeScript()],
		[],
		true,
	);
	signal?.throwIfAborted();
	return { html, inspection: receipt.result.data };
}
