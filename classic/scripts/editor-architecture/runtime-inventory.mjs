import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Actual compiled registry; this does not assert availability in a live project. */
export async function readRuntimeInventory() {
	const glue =
		await import("../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
	const bytes = await readFile(
		new URL(
			"../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.wasm",
			import.meta.url,
		),
	);
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./opencut_editor_runtime_wasm_bg.js": glue,
	});
	glue.__wbg_set_wasm(instance.exports);
	instance.exports.__wbindgen_start();
	const runtime = new glue.CanonicalEditorRuntime();
	try {
		const snapshot = runtime.capabilities();
		if (
			!Array.isArray(snapshot.capabilities) ||
			snapshot.capabilities.length === 0
		)
			throw new Error("Empty canonical registry");
		return {
			evidence:
				"Compiled WASM registry; no project attached. Browser host contracts may be registered, but no external IO or DOM adapter is serviced by this inventory process. Not a live agent availability or parity assertion.",
			wasmSha256: createHash("sha256").update(bytes).digest("hex"),
			...snapshot,
		};
	} finally {
		runtime.free();
	}
}

export function checkCanonicalLiterals(inventory, registry) {
	const descriptors = new Map(
		registry.capabilities.map((entry) => [entry.id, entry]),
	);
	return inventory.canonicalCallSites.flatMap((call) => {
		const descriptor = descriptors.get(call.capability);
		const context = `${call.file}:${call.line} (${call.capability})`;
		if (!descriptor)
			return [`${context}: capability missing from compiled registry`];
		if (descriptor.documentSupport === "rewrite")
			return [
				`${context}: Classic adapter references a rewrite-only capability`,
			];
		return [];
	});
}
