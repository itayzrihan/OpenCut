import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [projectArg, rootArg, mode = "capture"] = process.argv.slice(2);
if (
  !projectArg ||
  !rootArg ||
  !["capture", "undo", "redo", "reopen"].includes(mode)
)
  throw new Error("Expected project, evidence root and optional history mode");
const directory = resolve(projectArg),
  folder = join(resolve(rootArg), "en-source-audio"),
  projectId = basename(directory),
  accountId = basename(dirname(dirname(directory)));
const project = JSON.parse(
  await readFile(join(directory, "project.json"), "utf8"),
);
const bundle = JSON.parse(project.__opencutEditorSession).saved.bundle,
  run = JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id, projectId);
assert.equal(run.phase, "completed");
for (const scope of [run.scope, bundle.conversation, bundle.artifacts]) {
  assert.equal(scope.projectId, projectId);
  assert.equal(scope.accountId, accountId);
}
const baseline = JSON.parse(
  await readFile(join(folder, "baseline.json"), "utf8"),
);
assert.equal(baseline.projectId, projectId);
if (mode !== "capture") {
  const completion = JSON.parse(
    await readFile(join(folder, "completion.json"), "utf8"),
  );
  assert.equal(run.scope.runId, completion.runId);
  const expected =
    mode === "undo"
      ? baseline.classic
      : JSON.parse(
          await readFile(
            join(folder, "canonical-before-history-qa.json"),
            "utf8",
          ),
        );
  assert.deepEqual(bundle.archive.classic, expected);
  if (mode === "reopen")
    assert.ok(bundle.archive.revision >= completion.finalRevision + 4);
  else
    assert.equal(
      bundle.archive.revision,
      completion.finalRevision + (mode === "undo" ? 2 : 4),
    );
  await writeFile(
    join(folder, `${mode}-state.json`),
    JSON.stringify(
      {
        projectId,
        runId: run.scope.runId,
        phase: run.phase,
        revision: bundle.archive.revision,
        classic: bundle.archive.classic,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ mode, verified: true, revision: bundle.archive.revision }),
  );
} else {
  assert.equal(run.verifiedRevision, run.revision);
  assert.equal(bundle.archive.revision, run.revision);
  assert.equal(run.revision, baseline.revision + 2);
  const before = baseline.classic.document.scenes[0],
    scene = bundle.archive.classic.document.scenes.find(
      (s) => s.id === before.id,
    );
  const original = before.tracks.main.elements[0],
    video = scene.tracks.main.elements[0];
  assert.deepEqual(video, { ...original, isSourceAudioEnabled: false });
  assert.equal(before.tracks.audio.length, 0);
  assert.equal(scene.tracks.audio.length, 1);
  const track = scene.tracks.audio[0];
  assert.equal(track.muted, true);
  assert.equal(track.elements.length, 1);
  const audio = track.elements[0];
  assert.notEqual(audio.id, video.id);
  assert.equal(audio.type, "audio");
  assert.equal(audio.sourceType, "upload");
  for (const key of [
    "mediaId",
    "startTime",
    "duration",
    "trimStart",
    "trimEnd",
    "sourceDuration",
    "retime",
  ])
    assert.deepEqual(audio[key], original[key]);
  for (const key of [
    "volume",
    "muted",
    "audioSyncOffset",
    "fadeInDuration",
    "fadeOutDuration",
  ])
    assert.equal(
      audio.params[key] ?? (key === "muted" ? false : 0),
      original.params[key] ?? (key === "muted" ? false : 0),
    );
  const oldKeys = original.animations.volume.keys,
    newKeys = audio.animations.volume.keys;
  assert.equal(newKeys.length, oldKeys.length);
  for (const [index, key] of oldKeys.entries()) {
    assert.equal(newKeys[index].time, key.time);
    assert.equal(newKeys[index].value, key.value);
    assert.equal(newKeys[index].segmentToNext, key.segmentToNext);
    assert.ok(!oldKeys.some((old) => old.id === newKeys[index].id));
  }
  assert.deepEqual(scene.tracks.overlay, before.tracks.overlay);
  assert.deepEqual(
    bundle.archive.classic.mediaAssets,
    baseline.classic.mediaAssets,
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
    ),
    task = manifest.tasks.find((t) => t.id === "en-source-audio");
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
  for (const id of [...task.capabilities, "history.list"])
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
    const item = bundle.artifacts.archive.items.find(
      (i) => i.metadata.id === id,
    );
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
    providerRounds: entries.filter((e) => e.kind === "round" && !e.review)
      .length,
    finalRevision: run.revision,
    outcome: "completed",
    autonomous: true,
    manualRepairs: 0,
    claimedSuccess: true,
    receipts,
    frames,
    finalMessage: run.finalMessage,
    audioElementId: audio.id,
    audioTrackId: track.id,
    checks: {
      "owned-source-binding": "verified",
      sync: "verified-timeline-mapping",
      mute: "verified",
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
      frames: frames.length,
    }),
  );
}
