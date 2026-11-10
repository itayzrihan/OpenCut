// Fetch pinned public assets at build time. The editor runs both detectors locally.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../apps/web/public/browser-models/vision/", import.meta.url));
const pkg = "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.32.tgz";
const sri = "3tiAZnmKloYnRXYoO3dKltTUGnqeCwzC4lV03uY0vCsE+aveJTyEVQyZHOlQGQNsjK+gRHzkf9q08C99Qm2K0Q==";
const runtime = [
	"vision_bundle.mjs",
	"wasm/vision_wasm_internal.js",
	"wasm/vision_wasm_internal.wasm",
	"wasm/vision_wasm_nosimd_internal.js",
	"wasm/vision_wasm_nosimd_internal.wasm",
];
const models = [
	["pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"],
	["face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite", "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f"],
];
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function download(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`Model asset download failed (${response.status}): ${url}`);
	return Buffer.from(await response.arrayBuffer());
}
const stage = await mkdtemp(join(tmpdir(), "pocut-vision-"));
try {
	const archive = await download(pkg);
	if (createHash("sha512").update(archive).digest("base64") !== sri)
		throw new Error("MediaPipe package integrity check failed");
	const tar = join(stage, "runtime.tgz");
	await writeFile(tar, archive);
	execFileSync("tar", ["-xzf", tar, "-C", stage, ...runtime.map((name) => `package/${name}`)]);
	await mkdir(join(out, "wasm"), { recursive: true });
	for (const name of runtime)
		await writeFile(join(out, name), await readFile(join(stage, "package", name)));
	for (const [path, digest] of models) {
		const bytes = await download(`https://storage.googleapis.com/mediapipe-models/${path}`);
		if (hash(bytes) !== digest) throw new Error(`Model integrity check failed: ${path}`);
		await writeFile(join(out, path.split("/").at(-1)), bytes);
	}
	console.log("Verified MediaPipe vision runtime and both model files");
} finally {
	await rm(stage, { recursive: true });
}
