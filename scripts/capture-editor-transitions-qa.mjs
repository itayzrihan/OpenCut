import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [projectArg, rootArg] = process.argv.slice(2);
if (!projectArg || !rootArg)
  throw new Error("Expected project and evidence root");
const directory = resolve(projectArg),
  folder = join(resolve(rootArg), "en-transitions"),
  projectId = basename(directory),
  accountId = basename(dirname(dirname(directory)));
const project = JSON.parse(
    await readFile(join(directory, "project.json"), "utf8"),
  ),
  bundle = JSON.parse(project.__opencutEditorSession).saved.bundle,
  run = JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id, projectId);
for (const scope of [run.scope, bundle.conversation, bundle.artifacts]) {
  assert.equal(scope.projectId, projectId);
  assert.equal(scope.accountId, accountId);
}
assert.equal(run.phase, "completed");
assert.equal(run.verifiedRevision, run.revision);
assert.equal(bundle.archive.revision, run.revision);
const baseline = JSON.parse(
  await readFile(join(folder, "baseline.json"), "utf8"),
);
assert.equal(baseline.projectId, projectId);
assert.equal(run.revision, baseline.revision + 1);
const expected = structuredClone(baseline.classic),
  scene = bundle.archive.classic.document.scenes[0],
  expectedScene = expected.document.scenes[0];
const video = scene.tracks.main.elements[0],
  title = scene.tracks.overlay[0].elements[0];
const intro = video.transitions.in,
  outro = title.transitions.out;
assert.equal(intro.presetId, "fade");
assert.match(outro.presetId, /^slide-(left|right|up|down)$/);
assert.equal(intro.placement, "in");
assert.equal(intro.startTime, 0);
assert.ok(intro.duration > 0 && intro.duration <= video.duration);
assert.equal(outro.placement, "out");
assert.equal(outro.startTime, title.duration - outro.duration);
assert.ok(outro.duration > 0 && outro.duration <= title.duration);
assert.notEqual(intro.id, outro.id);
assert.ok(Object.keys(video.animations).includes("volume"));
assert.equal(scene.tracks.audio.length, 1);
expectedScene.tracks.main.elements[0].transitions = video.transitions;
expectedScene.tracks.overlay[0].elements[0].transitions = title.transitions;
assert.deepEqual(
  bundle.archive.classic,
  expected,
  "Only the two transitions may change; audio keys/settings and all other fields must survive",
);
const manifest = JSON.parse(
    await readFile(
      new URL("../resources/editor-agent-qa/tasks.json", import.meta.url),
      "utf8",
    ),
  ),
  task = manifest.tasks.find((t) => t.id === "en-transitions");
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
  receipts.findIndex((r) => r.capabilityId === task.capabilities[0]) <
    receipts.findIndex((r) => r.capabilityId === task.capabilities[1]),
);
assert.ok(
  receipts.some(
    (r) => r.capabilityId === "app.state.read" && r.revision === run.revision,
  ),
);
const review = entries.findLast((e) => e.review && e.artifactIds.length);
assert.ok(review);
assert.equal((review.issues ?? []).length, 0);
const frames = [];
async function saveArtifact(id, file, timeTicks) {
  const item = bundle.artifacts.archive.items.find((i) => i.metadata.id === id);
  assert.ok(
    item &&
      item.metadata.mimeType === "image/jpeg" &&
      item.metadata.byteSize <= 250000,
  );
  const bytes = Buffer.from(item.dataBase64, "base64"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, item.metadata.sha256);
  assert.equal(bytes.length, item.metadata.byteSize);
  await writeFile(join(folder, file), bytes);
  return {
    file,
    sha256,
    artifactId: id,
    ...(timeTicks === undefined ? {} : { timeTicks }),
  };
}
for (const [index, id] of review.artifactIds.entries())
  frames.push(await saveArtifact(id, `frame-${index + 1}.jpg`));
const activities = entries
  .flatMap((e) => e.activities ?? [])
  .filter(
    (a) =>
      a.ok &&
      a.input.action === "invoke" &&
      a.input.id === "editor.preview.render" &&
      a.output.revision === run.revision,
  );
const previewTimes = [
  video.startTime + intro.startTime + intro.duration / 2,
  title.startTime + outro.startTime + outro.duration / 2,
];
const previews = [];
for (const [index, time] of previewTimes.entries()) {
  const activity = activities.find((a) => a.input.input.timeTicks === time);
  assert.ok(activity, "The actor must render the middle of each transition");
  assert.equal(activity.input.input.projectId, projectId);
  assert.equal(activity.input.input.sceneId, scene.id);
  const artifact = activity.output.result.result.data.artifact;
  assert.ok(
    run.receipts.some(
      (r) =>
        r.capabilityId === "editor.preview.render" &&
        r.artifactIds.includes(artifact.id),
    ),
  );
  previews.push(
    await saveArtifact(
      artifact.id,
      `transition-midpoint-${index + 1}.jpg`,
      time,
    ),
  );
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
  previews,
  finalMessage: run.finalMessage,
  checks: {
    "edge-anchors": "verified",
    "retained-audio-animation": "verified",
    "render-visible": "pending-independent-visual-check",
  },
};
await writeFile(
  join(folder, "completion.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(folder, "canonical-final.json"),
  JSON.stringify(bundle.archive.classic, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    phase: run.phase,
    revision: run.revision,
    providerRounds: report.providerRounds,
    frames: frames.length,
    midpointTicks: previewTimes,
  }),
);
