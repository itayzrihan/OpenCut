// Read-only public evidence projection. Never exports provider state or credentials.
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const [projectDirectoryArg, operationId, outputDirectoryArg, startTicksArg = "0", expectedRequestPath] = process.argv.slice(2);
if (!projectDirectoryArg || !operationId || !outputDirectoryArg) throw new Error("Usage: node capture-editor-agent-image-evidence.mjs <QA project directory> <operationId> <output directory>");
const expectedStartTicks = Number(startTicksArg);
if (!Number.isSafeInteger(expectedStartTicks) || expectedStartTicks < 0) throw new Error("Expected clip start must be nonnegative integer ticks");
const projectDirectory = await realpath(projectDirectoryArg);
const project = JSON.parse(await readFile(join(projectDirectory, "project.json"), "utf8"));
const projectId = project.metadata.id;
if (projectId !== dirname(join(projectDirectory, "project.json")).split(/[\\/]/).at(-1)) throw new Error("Project directory does not match its stored identity");
const jobKey = createHash("sha256").update(JSON.stringify([projectId, operationId])).digest("hex");
const accountDirectory = dirname(dirname(projectDirectory));
const journal = JSON.parse(await readFile(join(accountDirectory, "image-jobs", `${jobKey}.json`), "utf8"));
if (journal.projectId !== projectId || journal.operationId !== operationId || journal.state !== "completed") throw new Error("A matching completed image journal is required");
let requestDigestVerified = false;
if (expectedRequestPath) {
  const expected = JSON.parse(await readFile(expectedRequestPath, "utf8"));
  if (expected.projectId !== projectId || expected.operationId !== operationId || expected.model !== "gpt-5.6-terra" || !Array.isArray(expected.references)) throw new Error("Expected request scope or model differs");
  const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  const digest = createHash("sha256").update(JSON.stringify(sort(expected))).digest("hex");
  if (digest !== journal.digest) throw new Error("Completed journal differs from the exact expected request and reference fingerprints");
  requestDigestVerified = true;
}
const mediaIndex = JSON.parse(await readFile(join(projectDirectory, "media", "index.json"), "utf8"));
const media = mediaIndex.find((entry) => entry.id === journal.result.mediaId);
if (!media?.storedPath || isAbsolute(media.storedPath)) throw new Error("Generated image is not stored inside the project");
const imagePath = await realpath(resolve(projectDirectory, media.storedPath));
const contained = relative(projectDirectory, imagePath);
if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("Generated image escapes the project directory");
const bytes = await readFile(imagePath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== journal.result.sha256 || bytes.length !== journal.result.byteSize) throw new Error("Stored generated image differs from its dispatch journal");
const require = createRequire(new URL("../classic/apps/web/package.json", import.meta.url));
const sharp = require("sharp");
const metadata = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).metadata();
const { data, info } = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let transparent = 0, opaque = 0, partial = 0;
let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
for (let pixel = 0; pixel < info.width * info.height; pixel++) {
  const alpha = data[pixel * info.channels + 3];
  if (alpha === 0) transparent++; else if (alpha === 255) opaque++; else partial++;
  if (alpha >= 128) {
    const x = pixel % info.width, y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
}
const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
const session = typeof project.__opencutEditorSession === "string" ? JSON.parse(project.__opencutEditorSession) : null;
const checkpoint = session?.saved?.bundle?.agentCheckpoint ? JSON.parse(session.saved.bundle.agentCheckpoint) : null;
const classic = session?.saved?.bundle?.archive?.classic ?? null;
const accountId = accountDirectory.split(/[\\/]/).at(-1);
if (checkpoint && (checkpoint.run.scope.accountId !== accountId || checkpoint.run.scope.projectId !== projectId)) throw new Error("Checkpoint belongs to another account or project");
if (classic && classic.document.metadata.id !== projectId) throw new Error("Canonical archive belongs to another project");
const allClips = project.scenes.flatMap((scene) => [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio].flatMap((track) => track.elements.map((element) => ({ sceneId: scene.id, trackId: track.id, element }))));
const matching = allClips.filter(({ element }) => element.mediaId === journal.result.mediaId);
const pipelineAccepted = Boolean(classic?.mediaAssets?.some((asset) => asset.id === journal.result.mediaId) && matching.length === 1 && matching.some(({ element }) => element.type === "image" && element.startTime === expectedStartTicks && element.duration === 360000) && transparent > 0 && opaque + partial > 0);
const report = {
  capturedAt: new Date().toISOString(), provenance: "real-provider", transport: "local-browser", projectId, operationId,
  journal: { state: journal.state, startedAt: journal.startedAt, completedAt: journal.completedAt, jobKey },
  image: { file: "generated.png", sha256, byteSize: bytes.length, width: info.width, height: info.height, hasAlpha: metadata.hasAlpha, transparentPixels: transparent, opaquePixels: opaque, partialAlphaPixels: partial, centerRgba: [...data.subarray(center, center + 4)], visibleBounds: maxX < 0 ? null : { alphaThreshold: 128, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } },
  canonicalMediaRegistered: Boolean(classic?.mediaAssets?.some((asset) => asset.id === journal.result.mediaId)),
  expectedStartTicks,
  requestDigestVerified,
  timeline: matching.map(({ sceneId, trackId, element }) => ({ sceneId, trackId, elementId: element.id, mediaId: element.mediaId, type: element.type, startTime: element.startTime, duration: element.duration })),
  agent: checkpoint ? { scope: { projectId: checkpoint.run.scope.projectId, runId: checkpoint.run.scope.runId }, phase: checkpoint.run.phase, finalMessage: checkpoint.run.finalMessage, receipts: checkpoint.run.receipts.map((receipt) => ({ capabilityId: receipt.capabilityId, callId: receipt.callId, revision: receipt.revision, committed: receipt.committed, artifactIds: receipt.artifactIds })) } : null,
  visualPromptCompliance: "pending-visual-review",
  pipelineAccepted,
  completionAccepted: pipelineAccepted && checkpoint?.run.phase === "completed",
};
const outputDirectory = resolve(outputDirectoryArg);
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "generated.png"), bytes);
await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ projectId, imageSha256: sha256, width: info.width, height: info.height, transparentPixels: transparent, timelineClips: matching.length, pipelineAccepted, completionAccepted: report.completionAccepted }));
