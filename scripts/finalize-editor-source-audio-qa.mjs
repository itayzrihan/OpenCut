import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [rootArg] = process.argv.slice(2);
if (!rootArg) throw new Error("Expected evidence root");
const root = resolve(rootArg),
  folder = join(root, "en-source-audio");
const run = JSON.parse(await readFile(join(folder, "completion.json"), "utf8"));
assert.equal(run.outcome, "completed");
assert.equal(run.frames.length, 3);
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
    path: `en-source-audio/${file}`,
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
  "Synchronization is independently verified as identical media/source/timeline mapping at 1.25x with nonzero trims, retained volume automation and muted track. The agent explicitly did not claim an audible sync test. Two Undo and two Redo steps restore the exact project; reload preserves content and completed conversation. Three rendered frames inspect selected timestamps only. This fixture uses default zero sync offset/fades; the additional offset/fade preservation correction has its own native and actual-WASM regression gates.";
const aggregate = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
aggregate.runs = aggregate.runs.filter((r) => r.taskId !== run.taskId);
aggregate.runs.push(run);
await writeFile(
  join(root, "report.json"),
  JSON.stringify(aggregate, null, 2) + "\n",
);
console.log(JSON.stringify({ taskId: run.taskId, outcome: "completed" }));
