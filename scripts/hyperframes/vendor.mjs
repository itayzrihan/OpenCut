// Capture the exact dependencies used by the pinned registry. No source execution.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../resources/hyperframes/vendor/", import.meta.url));
const files = [];
let previous;
try { previous = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const version of ["3.14.2", "3.15.0"]) {
  for (const file of ["dist/gsap.min.js", "README.md", "package.json", "LICENSE.html"]) {
    const url = file === "LICENSE.html" ? "https://gsap.com/community/standard-license/" : `https://cdn.jsdelivr.net/npm/gsap@${version}/${file}`;
    const relativePath = `gsap/${version}/${file}`;
    const destination = path.join(root, relativePath);
    let bytes;
    try { bytes = await readFile(destination); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 500000) throw new Error("Unexpected vendor dependency size");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pinned = previous?.files.find((file) => file.path === relativePath);
    if (pinned && (pinned.sha256 !== sha256 || pinned.sourceUrl !== url)) throw new Error(`Previously pinned vendor file changed: ${relativePath}`);
    files.push({ package: "gsap", version, path: relativePath, sourceUrl: url, bytes: bytes.length, sha256 });
  }
}
await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, files: [...(previous?.files ?? []).filter((file) => file.package !== "gsap"), ...files] }, null, 2) + "\n");
console.log(`Captured ${files.length} exact-version vendor files, including their licenses.`);
