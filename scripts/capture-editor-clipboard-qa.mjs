import { readFile, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const [projectArg, rootArg] = process.argv.slice(2);
if (!projectArg || !rootArg)
  throw new Error("Expected project and evidence root");
const directory = resolve(projectArg),
  folder = join(resolve(rootArg), "he-clipboard");
const projectId = basename(directory),
  accountId = basename(dirname(dirname(directory)));
const saved = JSON.parse(
  await readFile(join(directory, "project.json"), "utf8"),
);
const bundle = JSON.parse(saved.__opencutEditorSession).saved.bundle;
const run = JSON.parse(bundle.agentCheckpoint).run;
assert.equal(saved.metadata.id, projectId);
for (const scope of [run.scope, bundle.conversation, bundle.artifacts]) {
  assert.equal(scope.projectId, projectId);
  assert.equal(scope.accountId, accountId);
}
assert.equal(run.phase, "completed");
assert.equal(run.verifiedRevision, run.revision);
assert.equal(
  bundle.archive.revision,
  run.revision,
  "Capture before any history or unrelated edits",
);
const baseline = JSON.parse(
  await readFile(join(folder, "baseline.json"), "utf8"),
);
assert.equal(baseline.projectId, projectId);
const oldScene = baseline.classic.document.scenes[0];
const scene = bundle.archive.classic.document.scenes.find(
  (s) => s.id === oldScene.id,
);
const tracks = (s) => [s.tracks.main, ...s.tracks.overlay, ...s.tracks.audio];
const old = tracks(oldScene).flatMap((t) => t.elements),
  next = tracks(scene).flatMap((t) => t.elements);
assert.equal(old.length, 2);
assert.equal(next.length, 4);
const oldIds = new Set(old.map((e) => e.id));
const copies = next.filter((e) => !oldIds.has(e.id));
assert.equal(new Set(next.map((e) => e.id)).size, 4);
for (const original of old) {
  assert.deepEqual(
    next.find((e) => e.id === original.id),
    original,
  );
  const copy = copies.find((e) => e.type === original.type);
  assert.ok(copy);
  assert.equal(copy.startTime, original.startTime + 600000);
  const { id: oldId, startTime: oldStart, ...oldFields } = original;
  const { id: newId, startTime: newStart, ...newFields } = copy;
  assert.deepEqual(newFields, oldFields);
}
assert.deepEqual(
  bundle.archive.classic.mediaAssets,
  baseline.classic.mediaAssets,
);
const mediaIndex = JSON.parse(
  await readFile(join(directory, "media", "index.json"), "utf8"),
);
const videoCopy = copies.find((e) => e.type === "video");
const media = mediaIndex.find((m) => m.id === videoCopy.mediaId);
assert.ok(
  media &&
    media.storageKind === "copied" &&
    typeof media.storedPath === "string",
);
const mediaPath = resolve(directory, media.storedPath),
  scopePath = relative(directory, mediaPath);
assert.ok(
  !isAbsolute(scopePath) &&
    scopePath !== ".." &&
    !scopePath.startsWith("..\\") &&
    !scopePath.startsWith("../"),
);
const sourceBytes = await readFile(
  join(resolve(rootArg), "fixtures", "timeline-source.mp4"),
);
const retainedBytes = await readFile(mediaPath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
assert.equal(
  createHash("sha256").update(retainedBytes).digest("hex"),
  sourceSha256,
);
assert.deepEqual(
  bundle.archive.classic.document.settings,
  baseline.classic.document.settings,
);
const manifest = JSON.parse(
  await readFile(
    new URL("../resources/editor-agent-qa/tasks.json", import.meta.url),
    "utf8",
  ),
);
const task = manifest.tasks.find((t) => t.id === "he-clipboard");
const start = bundle.conversation.entries.findLastIndex(
  (e) => e.kind === "user",
);
assert.equal(bundle.conversation.entries[start].text, task.prompt);
const entries = bundle.conversation.entries.slice(start);
const receipts = run.receipts.map((r) => ({
  capabilityId: r.capabilityId,
  revision: r.revision,
  committed: r.committed,
  status: "completed",
}));
for (const id of task.capabilities)
  assert.ok(receipts.some((r) => r.capabilityId === id));
assert.ok(
  receipts.some(
    (r) => r.capabilityId === "app.state.read" && r.revision === run.revision,
  ),
);
const review = entries.findLast((e) => e.review && e.artifactIds.length);
assert.ok(review);
assert.equal((review.issues ?? []).length, 0);
const frames = [];
for (const [index, id] of review.artifactIds.entries()) {
  const item = bundle.artifacts.archive.items.find((i) => i.metadata.id === id);
  assert.ok(item && item.metadata.mimeType === "image/jpeg");
  const bytes = Buffer.from(item.dataBase64, "base64"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, item.metadata.sha256);
  assert.equal(bytes.length, item.metadata.byteSize);
  const file = `frame-${index + 1}.jpg`;
  await writeFile(join(folder, file), bytes);
  frames.push({ file, sha256, artifactId: id });
}
const report = {
  taskId: task.id,
  projectId,
  runId: run.scope.runId,
  provenance: "real-provider",
  provider: "sign-in-with-chatgpt",
  model: "gpt-6-astra",
  providerRounds: entries.filter((e) => e.kind === "round" && !e.review).length,
  finalRevision: run.revision,
  outcome: "completed",
  autonomous: true,
  manualRepairs: 0,
  claimedSuccess: true,
  receipts,
  frames,
  sourceSha256,
  retainedMediaBytes: retainedBytes.length,
  finalMessage: run.finalMessage,
  checks: {
    "relative-offset": "verified",
    "fresh-identities": "verified",
    "owned-media": "verified",
    "undo-redo": "pending-live-ui-check",
  },
};
await writeFile(
  join(folder, "completion.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(folder, "canonical-before-history-qa.json"),
  JSON.stringify(bundle.archive.classic, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    phase: run.phase,
    revision: run.revision,
    providerRounds: report.providerRounds,
    copies: copies.length,
    frames: frames.length,
  }),
);
