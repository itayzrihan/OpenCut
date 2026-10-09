// Bun does not instantiate wasm-pack's bundler-target .wasm import. Load the
// same generated binary explicitly; never replace Rust logic with JS replicas.
import * as wasm from "../../../rust/wasm/pkg/opencut_wasm_bg.js";

const bytes = await Bun.file(
	new URL("../../../rust/wasm/pkg/opencut_wasm_bg.wasm", import.meta.url),
).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {
	"./opencut_wasm_bg.js": wasm,
});
wasm.__wbg_set_wasm(instance.exports);
const start = instance.exports.__wbindgen_start;
if (typeof start !== "function") throw new Error("Missing WASM startup export");
start();

export { wasm };
