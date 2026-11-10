// Reuse the pinned ONNX Runtime already installed by Transformers v3.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const target = new URL("../apps/web/public/browser-models/dbs/", import.meta.url);
const graph = await readFile(new URL("dbs-tiger.onnx", target));
if (createHash("sha256").update(graph).digest("hex") !==
	"dd4e0a51e199aa21f14db63fbb4270862b308712bb4c43d7a22a45b0fd74a44c")
	throw new Error("DBS-TIGER ONNX graph failed its integrity check");

const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const require = createRequire(webRequire.resolve("@huggingface/transformers"));
const dist = dirname(require.resolve("onnxruntime-web"));
const runtime = await readFile(join(dist, "ort.wasm.min.mjs"));
if (!runtime.subarray(0, 100).includes("v1.22.0-dev.20250409-89f8206ba4"))
	throw new Error("DBS-TIGER needs the ONNX Runtime version of the checked-in WASM assets");
await writeFile(new URL("ort.wasm.min.mjs", target), runtime);
console.log("Verified DBS-TIGER model and prepared its browser runtime");
