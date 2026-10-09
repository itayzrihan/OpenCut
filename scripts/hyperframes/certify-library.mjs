// Promote only references with explicit, source-bound reviewed prompts and
// reproducible technical evidence. This certifies this library generation,
// not every possible remix or the deployment of the complete editor.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const resources = path.join(root, "resources/hyperframes");
const exportDirectory = process.argv[2];
if (!exportDirectory) throw new Error("Pass the directory of a successful composed video/audio export test");
execFileSync(process.execPath, [path.join(root, "scripts/hyperframes/audit.mjs")], { stdio: "inherit" });
const catalog = JSON.parse(await readFile(path.join(resources, "catalog.json"), "utf8"));
const excluded = JSON.parse(await readFile(path.join(resources, "review-exclusions.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = JSON.parse(await readFile(path.join(exportDirectory, "report.json"), "utf8"));
if (!report.canonicalImportAndReopen || !report.actualSceneExporter || !report.actualWasmCompositor || !report.nativeVideoUnderlay || !report.standaloneInterval || !(report.timedHyperframesAudioInExport?.rmsDuring > 0.01) || !(report.timedHyperframesAudioInExport?.rmsBefore < 0.002) || !(report.timedHyperframesAudioInExport?.rmsAfter < 0.002)) throw new Error("Incomplete composed video/audio evidence");
const candidates = catalog.items.filter((item) => item.prepared && item.prompt.status === "reconstructed" && !excluded.items[item.id]);
const counts = { total: candidates.length, blocks: candidates.filter((item) => item.kind === "block").length, components: candidates.filter((item) => item.kind === "component").length };
if (counts.total < 150 || counts.blocks < 50 || counts.components < 50) throw new Error(`Insufficient reviewed references: ${JSON.stringify(counts)}`);
const entries = [];
for (const item of candidates) {
  const prepared = item.prepared;
  const evidence = prepared.evidence;
  if (item.verification.missingDeclaredFiles.length || !evidence.licenses.length || !evidence.offline || !evidence.import || !evidence.reopen || !evidence.deterministicSeek || evidence.frames.length !== 3 || item.prompt.provenance.sourceSha256 !== prepared.sourceSha256) throw new Error(`Incomplete reviewed package: ${item.id}`);
  const technicalBytes = await readFile(path.join(resources, prepared.sourcePath, evidence.technical.file));
  const technical = JSON.parse(technicalBytes);
  if (digest(technicalBytes) !== evidence.technical.sha256 || technical.sourceSha256 !== prepared.sourceSha256 || technical.frames[1].sha256 !== technical.frames[3].sha256 || !technical.offline || !technical.import || !technical.reopen || !technical.deterministicSeek) throw new Error(`Incomplete technical evidence: ${item.id}`);
  entries.push({ id: item.id, kind: item.kind, sourceSha256: prepared.sourceSha256, promptSha256: digest(item.prompt.text), technicalSha256: evidence.technical.sha256, frames: item.prompt.provenance.frames, review: "Codex source and three sampled rendered frames; prompt authored from the observed reference" });
}
const exportEvidence = [];
const destination = path.join(resources, "evidence/composed-export");
await mkdir(destination, { recursive: true });
for (const name of ["report.json", "mixed-export.webm", "export-0.8.png", "export-1.6.png"]) {
  const bytes = await readFile(path.join(exportDirectory, name));
  if (!bytes.length) throw new Error("Empty export artifact");
  await writeFile(path.join(destination, name), bytes);
  exportEvidence.push({ path: `evidence/composed-export/${name}`, bytes: bytes.length, sha256: digest(bytes) });
}
const certification = { schemaVersion: 1, upstreamCommit: catalog.upstreamCommit, scope: "preparedReferenceLibrary", counts, reviewer: "OpenCut / Codex", reviewMethod: "sourceAndThreeSampledFrames", exportCoverage: { reference: report.reference, scope: "shared compositor integration: native video underlay, standalone interval and timed source audio", files: exportEvidence }, limitations: ["Sampled visual review is not a frame-by-frame review of every animation", "Composed export is tested on the shared path with a representative remix, not every possible composition", "System fallback fonts may vary by platform where the source does not load a font file", "Reconstructed prompts are labelled and do not guarantee pixel-identical regeneration", "Popularity is unknown unless upstream supplies a ranking", "Electron shell and HTTPS SaaS deployment acceptance are separate release gates"], entries };
await writeFile(path.join(resources, "certification.json"), JSON.stringify(certification, null, 2) + "\n");
for (const item of candidates) {
  item.verification = { ...item.verification, status: "verified", dependencyClosure: true, preview: true, import: true, reopen: true, transparentOverlay: item.prepared.evidence.frames.some((frame) => frame.transparentPixels) };
  item.prepared.status = "verified";
  item.prepared.evidence.remaining = [];
  item.prepared.evidence.reviewScope = certification.reviewMethod;
  item.prepared.evidence.certificationScope = certification.scope;
}
await writeFile(path.join(resources, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
execFileSync(process.execPath, [path.join(root, "scripts/hyperframes/audit.mjs"), "--acceptance"], { stdio: "inherit" });
