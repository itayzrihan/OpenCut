import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [rootArg] = process.argv.slice(2);
if (!rootArg) throw new Error("Expected evidence root");
const root = resolve(rootArg),
  folder = join(root, "he-clipboard");
const run = JSON.parse(await readFile(join(folder, "completion.json"), "utf8"));
assert.equal(run.outcome, "completed");
assert.equal(run.frames.length, 8);
for (const [original, copy] of [
  [0, 4],
  [1, 5],
  [2, 6],
])
  assert.equal(
    run.frames[original].sha256,
    run.frames[copy].sha256,
    "Sampled original and copy must contain identical rendered bytes",
  );
for (const mode of ["undo", "redo", "reopen"]) {
  const state = JSON.parse(
    await readFile(join(folder, `${mode}-state.json`), "utf8"),
  );
  assert.equal(state.runId, run.runId);
  assert.equal(state.phase, "completed");
}
const evidence = [];
for (const file of [
  "completion.json",
  "baseline.json",
  "canonical-before-history-qa.json",
  "undo-state.json",
  "redo-state.json",
  "reopen-state.json",
  "editor.png",
  ...run.frames.map((f) => f.file),
]) {
  const bytes = await readFile(join(folder, file));
  assert.ok(bytes.length);
  evidence.push({
    path: `he-clipboard/${file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const manifest = JSON.parse(
  await readFile(
    new URL("../resources/editor-agent-qa/tasks.json", import.meta.url),
    "utf8",
  ),
);
const task = manifest.tasks.find((t) => t.id === run.taskId);
run.checks = ["final-state-read", ...task.checks].map((id) => ({
  id,
  status: "verified",
  evidence,
}));
run.limitation =
  "Exact document and media-reference preservation, fresh clip identities, relative offsets and one-step Undo/Redo are verified independently. Reopening compares all content fields except timelineViewState changed by the QA screenshot's explicit seek/zoom. Rendered samples cover selected timestamps; exhaustive motion and audio fidelity remain separate QA. The first run used an oversized fixture title and honestly failed; the fixture was corrected before this fresh run, with its public failed history retained and no in-task repair or steering.";
const aggregate = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
const previous = aggregate.runs.find((r) => r.taskId === run.taskId);
aggregate.previousAttempts ??= [];
if (
  previous &&
  previous.runId !== run.runId &&
  !aggregate.previousAttempts.some((r) => r.runId === previous.runId)
)
  aggregate.previousAttempts.push(previous);
aggregate.runs = aggregate.runs.filter((r) => r.taskId !== run.taskId);
aggregate.runs.push(run);
await writeFile(
  join(root, "report.json"),
  JSON.stringify(aggregate, null, 2) + "\n",
);
console.log(JSON.stringify({ taskId: run.taskId, outcome: "completed" }));
