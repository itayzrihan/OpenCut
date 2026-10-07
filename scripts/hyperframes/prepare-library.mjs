// Promote reproducible technical evidence into bundled candidates. This does
// not certify visual quality, prompt fidelity, or full acceptance.
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const resources = path.join(root, "resources/hyperframes");
const catalog = JSON.parse(await readFile(path.join(resources, "catalog.json"), "utf8"));
const evidenceRoot = path.join(root, ".local/hyperframes-examples-batch", catalog.upstreamCommit);
const report = JSON.parse(await readFile(path.join(evidenceRoot, "report.json"), "utf8"));
const exclusions = JSON.parse(await readFile(path.join(resources, "review-exclusions.json"), "utf8"));
if (exclusions.upstreamCommit !== catalog.upstreamCommit) throw new Error("Review generation differs");
for (const item of catalog.items) {
  // A regenerated inventory must pass review/certification again. Do not keep
  // a green label from an older technical run, even when source bytes match.
  if (item.verification.status === "verified") item.verification = { ...item.verification, status: "captured", dependencyClosure: false, preview: false, import: false, reopen: false, transparentOverlay: null };
  if (!report.results.some((result) => result.id === item.id)) delete item.prepared;
  if (!exclusions.items[item.id]) continue;
  delete item.prepared;
  item.verification = { ...item.verification, status: "excluded", dependencyClosure: false, preview: false, import: false, reopen: false, transparentOverlay: null, reviewNote: exclusions.items[item.id] };
}
if (report.upstreamCommit !== catalog.upstreamCommit) throw new Error("Evidence generation differs");
if (!process.argv.includes("--allow-partial") && (report.completed.block < 50 || report.completed.component < 50 || report.results.length < 150)) throw new Error("The requested 150 technical candidates are not ready");
const vendor = JSON.parse(await readFile(path.join(resources, "vendor/manifest.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let packaged = 0;
for (const evidence of report.results) {
  const item = catalog.items.find((item) => item.id === evidence.id);
  if (exclusions.items[evidence.id]) { delete item.prepared; continue; }
  if (!item || !evidence.offline || !evidence.import || !evidence.reopen || !evidence.deterministicSeek || evidence.frames[1].sha256 !== evidence.frames[3].sha256) throw new Error("Incomplete technical evidence");
  const sourceBytes = await readFile(within(evidenceRoot, `${item.id}/source.json`));
  if (digest(sourceBytes) !== evidence.sourceSha256) throw new Error(`Evidence source hash differs: ${item.id}`);
  const source = JSON.parse(sourceBytes);
  if (source.entryFile !== evidence.entryFile || Object.keys(source.resourceAssetIds).length) throw new Error("This candidate packager accepts only closed text packages");
  const sourcePath = `prepared/${catalog.upstreamCommit}/${item.id}`;
  const destination = within(resources, sourcePath);
  const files = [];
  for (const [name, text] of Object.entries(source.files)) {
    if (typeof text !== "string") throw new Error("Expected UTF-8 source");
    let expected;
    if (name.startsWith("__opencut_vendor/")) {
      const dependency = vendor.files.find((file) => `__opencut_vendor/${file.path}` === name);
      if (!dependency) throw new Error(`Unknown vendor source: ${name}`);
      expected = await readFile(within(path.join(resources, "vendor"), dependency.path), "utf8");
      if (digest(expected) !== dependency.sha256) throw new Error("Vendor digest differs");
    } else {
      const original = item.files.find((file) => file.path === name);
      if (!original) throw new Error(`Unknown upstream source: ${name}`);
      expected = await readFile(within(within(resources, item.sourcePath), name), "utf8");
      if (digest(expected) !== original.sha256) throw new Error("Upstream digest differs");
      for (const url of evidence.replacements) {
        const dependency = vendor.files.find((file) => file.sourceUrl === url && (file.replacement || file.path.endsWith(".js")));
        if (!dependency) throw new Error("Unknown dependency replacement");
        expected = expected.replaceAll(url, `/__opencut_vendor/${dependency.path}`);
      }
    }
    if (text !== expected) throw new Error(`Unreviewed source transformation: ${item.id}/${name}`);
    const output = within(destination, name); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, text);
    files.push({ path: name, bytes: Buffer.byteLength(text), sha256: digest(text) });
  }
  const frames = [];
  await mkdir(path.join(destination, "evidence"), { recursive: true });
  await writeFile(path.join(destination, "evidence/source.json"), sourceBytes);
  await writeFile(path.join(destination, "evidence/technical.json"), JSON.stringify(evidence, null, 2) + "\n");
  for (const frame of evidence.frames.slice(0, 3)) {
    const original = within(evidenceRoot, `${item.id}/${frame.file}`);
    if (digest(await readFile(original)) !== frame.sha256) throw new Error("Evidence frame hash differs");
    const name = `evidence/${frame.file}`; const output = within(destination, name); await mkdir(path.dirname(output), { recursive: true }); await copyFile(original, output);
    frames.push({ ...frame, file: name });
  }
  const licenses = [];
  for (const relative of item.licensePaths) {
    const name = `licenses/upstream/${relative}`; const output = within(destination, name); await mkdir(path.dirname(output), { recursive: true });
    const bytes = await readFile(within(path.join(resources, "upstream", catalog.upstreamCommit), relative)); await writeFile(output, bytes);
    licenses.push({ path: name, sha256: digest(bytes) });
  }
  for (const url of evidence.replacements) {
    const dependency = vendor.files.find((file) => file.sourceUrl === url && (file.replacement || file.path.endsWith(".js")));
    for (const licensePath of dependency.licensePaths ?? [`${dependency.package}/${dependency.version}/LICENSE.html`]) {
    const license = vendor.files.find((file) => file.path === licensePath);
    if (!license) throw new Error("Missing dependency license capture");
    const name = `licenses/vendor/${license.path}`; const output = within(destination, name); await mkdir(path.dirname(output), { recursive: true });
    const bytes = await readFile(within(path.join(resources, "vendor"), license.path)); if (digest(bytes) !== license.sha256) throw new Error("License capture hash differs"); await writeFile(output, bytes);
    licenses.push({ path: name, sha256: license.sha256, sourceUrl: license.sourceUrl });
    }
  }
  item.prepared = { status: "technicalPassed", sourcePath, entryFile: source.entryFile, sourceSha256: evidence.sourceSha256, files: files.sort((a,b) => a.path.localeCompare(b.path)), evidence: { offline: true, import: true, reopen: true, deterministicSeek: true, durationSeconds: evidence.durationSeconds, frames, licenses, technical: { file: "evidence/technical.json", sha256: digest(JSON.stringify(evidence, null, 2) + "\n") }, remaining: ["visual and prompt review", "composed export coverage", "packaged delivery"] } };
  packaged++;
}
await writeFile(path.join(resources, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(JSON.stringify({ packaged, status: "technicalPassed", fullyVerified: 0 }));
function within(base, relative) {
  if (typeof relative !== "string" || !relative || /[\\:]/.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe package path");
  const resolved = path.resolve(base, relative); if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error("Package escaped its root"); return resolved;
}
