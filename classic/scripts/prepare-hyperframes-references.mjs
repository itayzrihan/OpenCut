import { cp, mkdir, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const audit = fileURLToPath(new URL("../../scripts/hyperframes/audit.mjs", import.meta.url));
const result = spawnSync(process.execPath, [audit], { stdio: "inherit" });
if (result.status !== 0) throw new Error("Pinned HyperFrames reference audit failed");
const destination = fileURLToPath(new URL("../apps/web/.hyperframes-references/", import.meta.url));
await mkdir(destination, { recursive: true });
await cp(fileURLToPath(new URL("../../resources/hyperframes/", import.meta.url)), destination, { recursive: true });
// These are immutable public reference pixels, never user/project captures.
// Content-addressed filenames make old previews safe across catalog updates.
const previews = fileURLToPath(new URL("../apps/web/public/hyperframes-reference-previews/", import.meta.url));
await mkdir(previews, { recursive: true });
const catalog = JSON.parse(await readFile(path.join(destination, "catalog.json"), "utf8"));
for (const item of catalog.items) {
  for (const frame of item.prepared?.evidence.frames ?? []) {
    if (!/^[a-f0-9]{64}$/.test(frame.sha256)) throw new Error("Invalid preview content address");
    await copyFile(path.join(destination, item.prepared.sourcePath, frame.file), path.join(previews, `${frame.sha256}.png`));
  }
}
