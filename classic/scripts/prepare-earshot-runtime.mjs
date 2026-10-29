#!/usr/bin/env node
/** Build-time only downloader. Browser synthesis never contacts a CDN. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const classic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(classic, "vendor/earshot");
const output = path.join(classic, "apps/web/public/earshot/runtime");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = JSON.parse(await readFile(path.join(vendor, "pyodide-assets.json"), "utf8"));
await mkdir(output, { recursive: true });
for (const asset of pin.assets) {
  const target = path.join(output, asset.file);
  let bytes = await readFile(target).catch(() => null);
  if (!bytes || hash(bytes) !== asset.sha256) {
    const response = await fetch(new URL(asset.file, pin.baseURL), { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Earshot runtime download failed: ${asset.file} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error(`Earshot runtime integrity check failed: ${asset.file}`);
    await writeFile(`${target}.tmp`, bytes);
    await rename(`${target}.tmp`, target);
  }
}
const manifest = JSON.parse(await readFile(path.join(vendor, "manifest.json"), "utf8"));
const sources = {};
for (const entry of manifest) {
  if (!/\.(py|json|md|toml)$/.test(entry.path) && entry.path !== "LICENSE") continue;
  const bytes = await readFile(path.join(vendor, "upstream", entry.path));
  if (hash(bytes) !== entry.sha256) throw new Error(`Vendored Earshot source was changed: ${entry.path}`);
  sources[entry.path] = bytes.toString("utf8");
}
const sourceBytes = Buffer.from(JSON.stringify(sources));
await writeFile(path.join(output, "source-files.json"), sourceBytes);
const adapters = [];
for (const file of ["worker.js", "renderer.py", "kernels.js"]) {
  const bytes = await readFile(path.join(classic, "apps/web/public/earshot", file));
  await writeFile(path.join(output, file), bytes);
  adapters.push({ file, size: bytes.length, sha256: hash(bytes) });
}
const runtime = { version: 1, pyodide: pin.version, assets: [...pin.assets, ...adapters, { file: "source-files.json", size: sourceBytes.length, sha256: hash(sourceBytes) }] };
await writeFile(path.join(output, "manifest.json"), JSON.stringify(runtime, null, 2) + "\n");
console.log(`Earshot runtime ready: ${runtime.assets.length} verified local resources; ${Object.keys(sources).length} source/document files.`);
