import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootArgument = process.argv.find((argument) => argument.startsWith("--root="));
const root = rootArgument ? path.resolve(rootArgument.slice(7)) : fileURLToPath(new URL("../../resources/hyperframes/", import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = path.join(root, "upstream", catalog.upstreamCommit);
const registryBytes = await readFile(path.join(snapshot, "registry/registry.json"));
if (digest(registryBytes) !== catalog.registrySha256) throw new Error("Registry snapshot hash differs");
const upstream = JSON.parse(registryBytes);
const reconstructed = JSON.parse(await readFile(path.join(root, "reconstructed-prompts.json"), "utf8"));
if (reconstructed.upstreamCommit !== catalog.upstreamCommit) throw new Error("Reconstructed prompt generation differs");
const ids = new Set();
let filesChecked = 0;
let bytesChecked = 0;
for (const item of catalog.items) {
  if (ids.has(item.id)) throw new Error(`Duplicate catalog ID ${item.id}`);
  ids.add(item.id);
  if (!upstream.items.some((original) => original.name === item.id && original.type === `hyperframes:${item.kind}`))
    throw new Error(`Unknown upstream item ${item.id}`);
  const directory = within(root, item.sourcePath);
  const paths = new Set();
  for (const file of item.files) {
    if (paths.has(file.path)) throw new Error(`Duplicate file ${item.id}/${file.path}`);
    paths.add(file.path);
    const bytes = await readFile(within(directory, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Source hash differs: ${item.id}/${file.path}`);
    filesChecked++; bytesChecked += bytes.length;
  }
  const manifest = JSON.parse(await readFile(path.join(directory, "registry-item.json"), "utf8"));
  if (manifest.name !== item.id || manifest.type !== `hyperframes:${item.kind}`) throw new Error(`Identity differs: ${item.id}`);
  if (typeof manifest.sourcePrompt === "string" && manifest.sourcePrompt.trim()) {
    if (item.prompt.status !== "original" || item.prompt.text !== manifest.sourcePrompt || item.prompt.provenance?.manifestSha256 !== item.manifestSha256 || item.prompt.provenance?.field !== "sourcePrompt") throw new Error(`Original prompt provenance differs: ${item.id}`);
  } else if (item.prompt.status === "original") throw new Error(`Original prompt claim has no upstream source: ${item.id}`);
  if (item.prompt.status === "reconstructed") {
    const provenance = item.prompt.provenance;
    if (!item.prepared || item.prompt.text !== reconstructed.prompts[item.id] || provenance?.sourceSha256 !== item.prepared.sourceSha256 || provenance?.manifestSha256 !== item.manifestSha256 || provenance?.promptSha256 !== digest(item.prompt.text) || provenance?.label !== reconstructed.label || JSON.stringify(provenance.frames) !== JSON.stringify(item.prepared.evidence.frames.map(({ timeSeconds, sha256 }) => ({ timeSeconds, sha256 })))) throw new Error(`Reconstructed prompt evidence differs: ${item.id}`);
  }
  for (const license of item.licensePaths) await readFile(within(snapshot, license));
  const missing = item.declaredFiles.filter((file) => !paths.has(file.path)).map((file) => file.path);
  if (JSON.stringify(missing) !== JSON.stringify(item.verification.missingDeclaredFiles)) throw new Error(`Missing-file report differs: ${item.id}`);
  if (item.prepared) {
    const prepared = item.prepared;
    const preparedRoot = within(root, prepared.sourcePath);
    const sourceBytes = await readFile(within(preparedRoot, "evidence/source.json"));
    if (digest(sourceBytes) !== prepared.sourceSha256) throw new Error(`Prepared source fingerprint differs: ${item.id}`);
    const source = JSON.parse(sourceBytes);
    if (source.entryFile !== prepared.entryFile || Object.keys(source.files).length !== prepared.files.length) throw new Error(`Prepared source inventory differs: ${item.id}`);
    const seen = new Set();
    for (const file of prepared.files) {
      if (seen.has(file.path)) throw new Error("Duplicate prepared file"); seen.add(file.path);
      const bytes = await readFile(within(preparedRoot, file.path));
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256 || bytes.toString("utf8") !== source.files[file.path]) throw new Error(`Prepared source integrity differs: ${item.id}/${file.path}`);
    }
    for (const file of [...prepared.evidence.frames, ...prepared.evidence.licenses]) {
      if (digest(await readFile(within(preparedRoot, file.file ?? file.path))) !== file.sha256) throw new Error(`Prepared evidence or license differs: ${item.id}`);
    }
  }
}
if (ids.size !== upstream.items.length) throw new Error("The complete catalog was not captured");
const vendor = JSON.parse(await readFile(path.join(root, "vendor/manifest.json"), "utf8"));
const vendorPaths = new Set();
for (const file of vendor.files) {
  if (vendorPaths.has(file.path)) throw new Error(`Duplicate vendor path: ${file.path}`);
  vendorPaths.add(file.path);
  const bytes = await readFile(within(path.join(root, "vendor"), file.path));
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Vendor integrity differs: ${file.path}`);
  if (!file.sourceUrl.startsWith("https://")) throw new Error(`Missing vendor provenance: ${file.path}`);
  if (file.transformation === "inlineFonts") {
    let expected = await readFile(within(path.join(root, "vendor"), file.derivedFrom), "utf8");
    for (const relative of file.dependencies) {
      const dependency = vendor.files.find((entry) => entry.path === relative);
      if (!dependency) throw new Error("Missing pinned font dependency");
      const extension = relative.split(".").pop();
      expected = expected.replaceAll(dependency.sourceUrl, `data:font/${extension};base64,${(await readFile(within(path.join(root, "vendor"), relative))).toString("base64")}`);
    }
    if (expected !== bytes.toString("utf8") || /https?:\/\//.test(expected) || !file.licensePaths?.length) throw new Error("Invalid offline font transformation");
    for (const relative of file.licensePaths) if (!vendor.files.some((entry) => entry.path === relative)) throw new Error("Missing font license");
  }
}
for (const file of vendor.files.filter((file) => file.path.endsWith(".js"))) {
  if (!vendorPaths.has(`${file.package}/${file.version}/LICENSE.html`)) throw new Error(`Missing vendor license capture: ${file.path}`);
}
const verified = catalog.items.filter((item) => item.verification.status === "verified" && item.verification.dependencyClosure && item.verification.preview && item.verification.import && item.verification.reopen && !item.verification.missingDeclaredFiles.length);
let acceptance = "notEstablished";
if (catalog.items.some((item) => item.verification.status === "verified")) {
  const certification = JSON.parse(await readFile(path.join(root, "certification.json"), "utf8"));
  const exclusions = JSON.parse(await readFile(path.join(root, "review-exclusions.json"), "utf8"));
  if (certification.upstreamCommit !== catalog.upstreamCommit || certification.scope !== "preparedReferenceLibrary" || exclusions.upstreamCommit !== catalog.upstreamCommit || certification.entries.length !== verified.length) throw new Error("Certification generation or scope differs");
  const certifiedIds = new Set();
  for (const entry of certification.entries) {
    if (certifiedIds.has(entry.id) || exclusions.items[entry.id]) throw new Error("Duplicate or rejected certification");
    certifiedIds.add(entry.id);
    const item = verified.find((candidate) => candidate.id === entry.id);
    if (!item?.prepared || item.prepared.status !== "verified" || item.prompt.status !== "reconstructed" || item.kind !== entry.kind || item.prepared.sourceSha256 !== entry.sourceSha256 || digest(item.prompt.text) !== entry.promptSha256 || JSON.stringify(item.prompt.provenance.frames) !== JSON.stringify(entry.frames)) throw new Error(`Unreviewed certified source: ${entry.id}`);
    const technicalBytes = await readFile(within(within(root, item.prepared.sourcePath), item.prepared.evidence.technical.file));
    const technical = JSON.parse(technicalBytes);
    if (digest(technicalBytes) !== entry.technicalSha256 || technical.sourceSha256 !== entry.sourceSha256 || !technical.offline || !technical.import || !technical.reopen || !technical.deterministicSeek || technical.frames[1].sha256 !== technical.frames[3].sha256 || technical.frames.slice(0,3).some((frame, index) => frame.sha256 !== entry.frames[index].sha256)) throw new Error(`Technical evidence differs: ${entry.id}`);
  }
  for (const file of certification.exportCoverage.files) {
    const bytes = await readFile(within(root, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error("Composed export evidence differs");
  }
  const counts = { total: verified.length, blocks: verified.filter((item) => item.kind === "block").length, components: verified.filter((item) => item.kind === "component").length };
  if (JSON.stringify(counts) !== JSON.stringify(certification.counts) || counts.total < 150 || counts.blocks < 50 || counts.components < 50) throw new Error("Certification does not meet the requested library size");
  acceptance = "preparedReferenceLibraryPassed";
}
const report = { upstreamCommit: catalog.upstreamCommit, captured: ids.size, filesChecked, bytesChecked, vendorFilesChecked: vendor.files.length, originalPrompts: catalog.items.filter((item) => item.prompt.status === "original").length, preparedCandidates: catalog.items.filter((item) => item.prepared).length, sourceIntegrity: "passed", incompleteDeclaredPackages: catalog.items.filter((item) => item.verification.missingDeclaredFiles.length).length, verified: verified.length, acceptance: "notEstablished" };
// Certification needs a separate reviewed evidence manifest. No collection of
// boolean flags in a generated inventory can self-certify this deliverable.
report.acceptance = acceptance;
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--acceptance") && acceptance !== "preparedReferenceLibraryPassed") {
  console.error("Full acceptance is not yet established: requires 150 packages (50 blocks + 50 components), pinned dependency/license closure, reviewed prompts, previews, import/reopen and export evidence.");
  process.exitCode = 1;
}
function within(base, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":") || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid package path");
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error("Package path escapes root");
  return resolved;
}
