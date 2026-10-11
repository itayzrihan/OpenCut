import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, readdir, lstat, copyFile, unlink, access } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import type { Source } from "./canonical";
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const textExtensions = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md", ".srt", ".vtt"]);
export async function visibleFiles(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Symlinks are not project assets");
    if (entry.isDirectory()) files.push(...await visibleFiles(dir, path));
    else files.push(path);
  }
  return files;
}
/** Upstream routes prepare candidate files. Only the Rust commit accepts them. */
export async function readCandidate(dir: string, blobDir: string, before: Source, createdBlobs: Set<string> = new Set()): Promise<Source> {
  const source: Source = { files: {}, assets: {} };
  await mkdir(blobDir, { recursive: true });
  for (const path of await visibleFiles(dir)) {
    const absolute = join(dir, path);
    if (textExtensions.has(extname(path).toLowerCase())) {
      const stat = await lstat(absolute);
      if (stat.size > 8 * 1024 * 1024) throw new Error(`Source file too large: ${path}`);
      source.files[path] = await readFile(absolute, "utf8");
    } else if (before.assets[path]) {
      // Existing assets are immutable; API writes to their paths are rejected by the host.
      source.assets[path] = before.assets[path];
    } else {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      source.assets[path] = { sha256, bytes: (await lstat(absolute)).size };
      try { await access(join(blobDir, sha256)); }
      catch { await copyFile(absolute, join(blobDir, sha256)); createdBlobs.add(sha256); }
    }
  }
  return source;
}
export async function materialize(dir: string, blobDir: string, source: Source) {
  await mkdir(dir, { recursive: true });
  const paths = new Set([...Object.keys(source.files), ...Object.keys(source.assets)]);
  for (const path of await visibleFiles(dir)) if (!paths.has(path)) await unlink(join(dir, path));
  for (const [path, content] of Object.entries(source.files)) {
    const absolute = join(dir, path);
    if (await readFile(absolute, "utf8").catch(() => null) === content) continue;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  for (const [path, asset] of Object.entries(source.assets)) {
    const absolute = join(dir, path);
    await mkdir(dirname(absolute), { recursive: true });
    if (await lstat(absolute).then(s => s.size === asset.bytes).catch(() => false)) continue;
    await copyFile(join(blobDir, asset.sha256), absolute);
  }
}
