// Read-only QA evidence: public checkpoint fields and canonical document only.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, resolve, basename, dirname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const [projectArg, baselineArg, outputArg, runId] = process.argv.slice(2);
if (!runId || !outputArg || !baselineArg || !projectArg)
  throw new Error("Usage: node capture-editor-transform-correction.mjs <project-directory> <public-baseline> <output-directory> <run-id>");
const directory = await realpath(projectArg);
const project = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
const baseline = JSON.parse(await readFile(baselineArg, "utf8"));
assert.equal(project.metadata.id, basename(directory));
assert.equal(project.metadata.id, baseline.ProjectId);
const accountId = basename(dirname(dirname(directory)));
const session = JSON.parse(project.__opencutEditorSession);
const bundle = session.saved.bundle;
const checkpoint = JSON.parse(bundle.agentCheckpoint);
assert.equal(checkpoint.run.scope.accountId, accountId);
assert.equal(checkpoint.run.scope.projectId, project.metadata.id);
assert.equal(checkpoint.run.scope.runId, runId);
assert.equal(checkpoint.run.phase, "completed");
const before = structuredClone(baseline.Classic);
const after = bundle.archive.classic;
assert.equal(after.document.metadata.id, project.metadata.id);
const clips = (classic) => classic.document.scenes.flatMap((scene) =>
  [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]
    .flatMap((track) => track.elements));
const prior = clips(before).find((clip) => clip.id === "classic-clip-2");
const corrected = clips(after).find((clip) => clip.id === "classic-clip-2");
assert.ok(prior && corrected);
assert.equal(corrected.params["transform.scaleX"], 0.95);
assert.equal(corrected.params["transform.scaleY"], 0.95);
prior.params["transform.scaleX"] = 0.95;
prior.params["transform.scaleY"] = 0.95;
// The canonical content transaction also updates the project's timestamp.
before.document.metadata.updatedAt = after.document.metadata.updatedAt;
// PowerShell's public baseline serializer trims insignificant millisecond zeroes.
// Normalize only ISO timestamp spellings, preserving the represented instant.
const normalizeDates = (value) => Array.isArray(value) ? value.map(normalizeDates) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(createdAt|updatedAt)$/.test(key) && typeof entry === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(entry)
      ? new Date(entry).toISOString() : normalizeDates(entry)])) : value;
assert.deepEqual(normalizeDates(after), normalizeDates(before), "Only purple scale and the transaction timestamp may change");
const receipts = checkpoint.run.receipts.map(({ capabilityId, revision, committed, artifactIds }) =>
  ({ capabilityId, revision, committed, artifactIds }));
assert.equal(receipts.filter((item) => item.capabilityId === "timeline.classic.elements.update" && item.committed).length, 1);
assert.ok(!receipts.some((item) => item.capabilityId === "imagegen.generate"));
assert.ok(receipts.some((item) => item.capabilityId === "app.state.read" && item.revision === baseline.Revision + 1));
assert.ok(receipts.filter((item) => item.capabilityId === "editor.preview.render" && item.revision === baseline.Revision).length >= 2);
assert.ok(receipts.filter((item) => item.capabilityId === "editor.preview.render" && item.revision === baseline.Revision + 1).length >= 2);
const mediaIndex = JSON.parse(await readFile(join(directory, "media", "index.json"), "utf8"));
const media = [];
for (const clip of clips(after)) {
  const asset = mediaIndex.find((item) => item.id === clip.mediaId);
  assert.ok(asset && !isAbsolute(asset.storedPath));
  const path = await realpath(resolve(directory, asset.storedPath));
  const scoped = relative(directory, path);
  assert.ok(!scoped.startsWith("..") && !isAbsolute(scoped));
  media.push({ clipId: clip.id, mediaId: clip.mediaId, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
}
assert.equal(media.find((item) => item.clipId === "classic-clip-1").sha256, "864f2d55fbac41b039e3ae5c63c7ac1687566e7483851a971ec97b4f6df26653");
assert.equal(media.find((item) => item.clipId === "classic-clip-2").sha256, "24f8fe2f9fe2d99cd6abdda06c54cdb92a5c2077f3f543925285c2c565939618");
const report = { capturedAt: new Date().toISOString(), projectId: project.metadata.id, runId,
  provenance: "real-provider", scope: "transform-only follow-up; externally supplied alpha bounds",
  phase: checkpoint.run.phase, beforeRevision: baseline.Revision, revision: baseline.Revision + 1,
  transform: corrected.params, media, receipts, finalMessage: checkpoint.run.finalMessage,
  canonicalContentComparisonPassed: true, unchangedMediaHashes: true,
  limitations: "Does not certify earlier image prompt fidelity, PNG regeneration, packaged Electron, or the full 20-task benchmark." };
await mkdir(resolve(outputArg), { recursive: true });
assert.equal(bundle.artifacts.accountId, accountId);
assert.equal(bundle.artifacts.projectId, project.metadata.id);
report.renderedFrames = [];
const sharp = createRequire(new URL("../classic/apps/web/package.json", import.meta.url))("sharp");
for (const [index, receipt] of receipts.filter((item) => item.capabilityId === "editor.preview.render").entries()) {
  assert.equal(receipt.artifactIds.length, 1);
  const artifact = bundle.artifacts.archive.items.find((item) => item.metadata.id === receipt.artifactIds[0]);
  assert.ok(artifact && artifact.metadata.mimeType === "image/jpeg" && artifact.metadata.byteSize <= 250000 && artifact.dataBase64.length <= 350000);
  const bytes = Buffer.from(artifact.dataBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.length, artifact.metadata.byteSize);
  assert.equal(sha256, artifact.metadata.sha256);
  const file = `frame-${index + 1}.jpg`;
  await writeFile(join(resolve(outputArg), file), bytes);
  const { data, info } = await sharp(bytes, { limitInputPixels: 1024 * 1024 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    // These fixtures contain one colored circle on the project's black background.
    // This is a composited JPEG color bound, never a claim about PNG alpha.
    if (Math.max(...data.subarray(pixel * 3, pixel * 3 + 3)) < 96) continue;
    const x = pixel % info.width, y = Math.floor(pixel / info.width);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  assert.ok(x1 >= x0 && y1 >= y0);
  report.renderedFrames.push({ file, artifactId: artifact.metadata.id, revision: receipt.revision, sha256,
    visibleColorBounds: { threshold: 96, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, centerX: (x0 + x1) / 2, centerY: (y0 + y1) / 2 } });
}
const turquoise = report.renderedFrames[2].visibleColorBounds;
const purple = report.renderedFrames[3].visibleColorBounds;
report.compositedCorrection = {
  widthDifferencePixels: Math.abs(turquoise.width - purple.width), heightDifferencePixels: Math.abs(turquoise.height - purple.height),
  centerDifferencePixels: Math.hypot(turquoise.centerX - purple.centerX, turquoise.centerY - purple.centerY),
  provenance: "external decoded render artifacts; color threshold, not alpha",
};
assert.ok(report.compositedCorrection.widthDifferencePixels <= 3 && report.compositedCorrection.heightDifferencePixels <= 3 && report.compositedCorrection.centerDifferencePixels <= 2);
await writeFile(join(resolve(outputArg), "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ phase: report.phase, revision: report.revision, canonicalContentComparisonPassed: true, unchangedMediaHashes: true }));
