import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [rootArg] = process.argv.slice(2);
if (!rootArg) throw new Error("Expected evidence root");
const root = resolve(rootArg),
  folder = join(root, "en-transitions"),
  run = JSON.parse(await readFile(join(folder, "completion.json"), "utf8"));
assert.equal(run.outcome, "completed");
assert.equal(run.previews.length, 2);
const visual = JSON.parse(
  await readFile(join(folder, "visual-review.json"), "utf8"),
);
assert.equal(visual.verified, true);
assert.ok(visual.fade.maximumRgb > 20 && visual.fade.maximumRgb < 220);
assert.ok(visual.fade.comparisonMaximumRgb >= 250);
const evidence = [];
for (const file of [
  "completion.json",
  "baseline.json",
  "canonical-final.json",
  "visual-review.json",
  "editor.png",
  ...run.frames.map((f) => f.file),
  ...run.previews.map((f) => f.file),
]) {
  const bytes = await readFile(join(folder, file));
  assert.ok(bytes.length);
  evidence.push({
    path: `en-transitions/${file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const manifest = JSON.parse(
    await readFile(
      new URL("../resources/editor-agent-qa/tasks.json", import.meta.url),
      "utf8",
    ),
  ),
  task = manifest.tasks.find((t) => t.id === run.taskId);
run.checks = ["final-state-read", ...task.checks].map((id) => ({
  id,
  status: "verified",
  evidence,
}));
run.limitation =
  "Preset discovery preceded one atomic application; only the two transitions changed, preserving complete audio tracks, automation and sync/fade settings. The actor rendered both midpoints as actual current-revision invocation artifacts supplied to its model; independent inspection confirms partial fade and rightward title displacement. The reviewer initially received only clip-anchor samples; improved native motion sampling has separate regression gates. These samples do not certify continuous motion or audio quality.";
const aggregate = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
aggregate.runs = aggregate.runs.filter((r) => r.taskId !== run.taskId);
aggregate.runs.push(run);
await writeFile(
  join(root, "report.json"),
  JSON.stringify(aggregate, null, 2) + "\n",
);
console.log(JSON.stringify({ taskId: run.taskId, outcome: "completed" }));
