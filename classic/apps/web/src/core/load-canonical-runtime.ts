"use client";

/** Keep the canonical registry and its validators off the initial WASM load. */
export async function loadCanonicalRuntime() {
	const { CanonicalEditorRuntime } =
		await import("opencut-editor-runtime-wasm");
	return new CanonicalEditorRuntime();
}
