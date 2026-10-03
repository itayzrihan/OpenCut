/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- this fixture instantiates the generated Rust WASM and its matching JS glue. */
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";

let initialized: Promise<
	typeof import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js")
> | null = null;

export async function createCanonicalTestRuntime(): Promise<CanonicalEditorRuntime> {
	initialized ??= (async () => {
		const glue =
			await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
		const bytes = await Bun.file(
			new URL(
				"../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm",
				import.meta.url,
			),
		).arrayBuffer();
		const { instance } = await WebAssembly.instantiate(bytes, {
			"./opencut_editor_runtime_wasm_bg.js": glue,
		});
		glue.__wbg_set_wasm(instance.exports);
		const start = instance.exports.__wbindgen_start;
		if (typeof start !== "function")
			throw new Error("Missing WASM startup export");
		start();
		return glue;
	})();
	const glue = await initialized;
	return new glue.CanonicalEditorRuntime() as unknown as CanonicalEditorRuntime;
}
