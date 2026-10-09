// Freeze the exact stylesheet used by the transition blocks, its font bytes,
// and each family's upstream license. Font bytes remain unmodified; the derived
// offline stylesheet embeds those bytes to fit the text-package import lane.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../resources/hyperframes/vendor/", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const url = "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&family=JetBrains+Mono:wght@400;700&family=Lato:wght@400;700&display=block";
const version = digest(url).slice(0, 16);
const prefix = `google-fonts/${version}`;
const files = [];
async function capture(relative, sourceUrl, headers) {
  const filename = path.join(root, relative);
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(sourceUrl, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${sourceUrl}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2_000_000) throw new Error("Oversize font resource");
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: "wx" });
  }
  const file = { package: "google-fonts", version, path: relative, sourceUrl, bytes: bytes.length, sha256: digest(bytes) };
  const prior = manifest.files.find((entry) => entry.path === relative);
  if (prior && (prior.sha256 !== file.sha256 || prior.sourceUrl !== sourceUrl)) throw new Error("Previously pinned font resource changed");
  files.push(file); return bytes;
}
const rawPath = `${prefix}/upstream.css`;
const css = (await capture(rawPath, url, { "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" })).toString("utf8");
let offline = css;
const dependencies = [];
for (const fontUrl of [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((match) => match[1]))]) {
  const extension = new URL(fontUrl).pathname.split(".").pop();
  if (!["woff2", "woff", "ttf"].includes(extension)) throw new Error("Unknown font container");
  const relative = `${prefix}/fonts/${digest(fontUrl).slice(0, 24)}.${extension}`;
  const bytes = await capture(relative, fontUrl);
  dependencies.push(relative);
  offline = offline.replaceAll(fontUrl, `data:font/${extension};base64,${bytes.toString("base64")}`);
}
if (/https?:\/\//.test(offline) || Buffer.byteLength(offline) > 1_900_000) throw new Error("Font stylesheet remains open or oversized");
const licenses = [];
for (const family of ["spacemono", "bebasneue", "jetbrainsmono", "lato"]) {
  const relative = `${prefix}/licenses/${family}-OFL.txt`;
  await capture(relative, `https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/OFL.txt`);
  licenses.push(relative);
}
const offlinePath = `${prefix}/offline.css`;
const bytes = Buffer.from(offline);
const prior = manifest.files.find((file) => file.path === offlinePath);
if (prior && prior.sha256 !== digest(bytes)) throw new Error("Pinned offline font stylesheet changed");
await writeFile(path.join(root, offlinePath), bytes);
files.push({ package: "google-fonts", version, path: offlinePath, sourceUrl: url, bytes: bytes.length, sha256: digest(bytes), replacement: true, derivedFrom: rawPath, dependencies, licensePaths: licenses, transformation: "inlineFonts" });
manifest.files = [...manifest.files.filter((file) => !files.some((entry) => entry.path === file.path)), ...files];
await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ files: files.length, offlineBytes: bytes.length, licenses: licenses.length }));
