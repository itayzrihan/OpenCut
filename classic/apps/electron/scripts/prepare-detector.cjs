"use strict";
// Build a self-contained Windows Python runtime from the dedicated, pinned
// detector environment. Never copy the developer's general site-packages.
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const classic = resolve(__dirname, "../../..");
async function main() {
	if (process.platform !== "win32") {
		console.log("Portable detector bundling currently targets Windows; other platforms retain their separately configured detector runtime");
		return;
	}
	const source = join(classic, ".local/subject-framing");
	const settings = await fs.readFile(join(source, "pyvenv.cfg"), "utf8").catch(() => { throw new Error("Run python classic/scripts/local-subject-framing/setup.py before packaging the detector"); });
	const home = /^home\s*=\s*(.+)$/m.exec(settings)?.[1]?.trim();
	const version = /^version\s*=\s*(.+)$/m.exec(settings)?.[1]?.trim();
	if (!home || !version) throw new Error("Detector environment does not identify its Python runtime");
	const target = process.env.OPENCUT_SUBJECT_RUNTIME || join(classic, ".local/subject-framing-portable");
	const requirements = await fs.readFile(join(classic, "scripts/local-subject-framing/requirements.txt"));
	const fingerprint = createHash("sha256").update(requirements).update(version).digest("hex");
	const marker = join(target, "opencut-runtime.json");
	const existing = await fs.readFile(marker, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
	if (existing && existing.fingerprint !== fingerprint) throw new Error("Choose a fresh OPENCUT_SUBJECT_RUNTIME directory for the updated Python dependencies");
	if (!existing) {
		await fs.mkdir(target, { recursive: true });
		for (const file of await fs.readdir(home)) if (/^(python.*\.(exe|dll)|vcruntime.*\.dll|LICENSE.txt)$/.test(file)) await fs.copyFile(join(home, file), join(target, file));
		const filter = (path) => !path.split(/[\\/]/).includes("__pycache__");
		await fs.cp(join(home, "DLLs"), join(target, "DLLs"), { recursive: true, filter });
		await fs.cp(join(home, "Lib"), join(target, "Lib"), { recursive: true, filter: (path) => filter(path) && !path.split(/[\\/]/).includes("site-packages") });
		await fs.cp(join(source, "Lib/site-packages"), join(target, "Lib/site-packages"), { recursive: true, filter });
		await fs.cp(join(source, "models"), join(target, "models"), { recursive: true });
		const model = await fs.readFile(join(target, "models/pose_landmarker_lite.task"));
		if (createHash("sha256").update(model).digest("hex") !== "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a") throw new Error("Detector model verification failed");
		await fs.writeFile(join(target, `python${version.split(".").slice(0, 2).join("")}._pth`), ".\nLib\nDLLs\nLib/site-packages\nimport site\n");
	}
	execFileSync(join(target, "python.exe"), ["-I", "-c", "import sys,cv2,mediapipe,numpy; from pathlib import Path; assert sys.flags.isolated; assert all(Path(m.__file__).resolve().is_relative_to(Path(sys.executable).parent) for m in (cv2,mediapipe,numpy)); print('Portable detector imports verified')"], { windowsHide: true, stdio: "inherit" });
	await fs.writeFile(marker, JSON.stringify({ format: 1, version, fingerprint }));
	console.log("Portable subject detector prepared");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
