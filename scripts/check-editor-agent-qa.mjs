// Acceptance report validator. This never generates model runs or passing evidence.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export async function checkReport({ manifest, report, evidenceRoot }) {
  const problems = [];
  const ids = new Set(manifest.tasks.map(t => t.id));
  if (ids.size !== 20 || manifest.tasks.length !== 20) problems.push("Manifest must contain exactly 20 unique cases");
  const runs = new Map();
  for (const run of report.runs ?? []) {
    if (!ids.has(run.taskId) || runs.has(run.taskId)) problems.push(`Unknown/duplicate case: ${run.taskId}`);
    runs.set(run.taskId,run);
  }
  let successes = 0, unsupportedSuccessClaims = 0;
  for (const task of manifest.tasks) {
    const run = runs.get(task.id);
    if (!run) { problems.push(`${task.id}: unattempted`); continue; }
    const failures = [];
    if (run.provenance !== "real-provider" || !run.provider || !run.model || !Number.isInteger(run.providerRounds) || run.providerRounds < 1) failures.push("missing actual provider provenance");
    if (!run.projectId || !run.runId || !["browser","packaged-electron"].includes(report.target)) failures.push("missing target/project/run scope");
    if (!Number.isSafeInteger(run.finalRevision) || run.finalRevision < 0) failures.push("missing final revision");
    const checks = run.checks ?? [];
    if (new Set(checks.map(c => c.id)).size !== checks.length) failures.push("duplicate checks");
    for (const id of ["final-state-read",...task.checks]) {
      const check = checks.find(c => c.id === id);
      if (!check || check.status !== "verified" || !check.evidence?.length) { failures.push(`unverified check ${id}`); continue; }
      for (const evidence of check.evidence) {
        try {
          if (!evidence.path || path.isAbsolute(evidence.path)) throw new Error("use a relative evidence path");
          const root = await fs.realpath(evidenceRoot);
          const target = await fs.realpath(path.resolve(root,evidence.path));
          const relative = path.relative(root,target);
          if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("evidence escapes its directory");
          const stat = await fs.stat(target);
          if (!stat.isFile() || stat.size < 1 || stat.size > 128*1024*1024) throw new Error("missing/oversized evidence");
          const hash = createHash("sha256").update(await fs.readFile(target)).digest("hex");
          if (hash !== evidence.sha256) throw new Error("evidence SHA mismatch");
        } catch (error) { failures.push(`${id}: ${error.message}`); }
      }
    }
    for (const id of task.capabilities) if (!run.receipts?.some(r => r.capabilityId === id && r.status === "completed")) failures.push(`missing completed receipt ${id}`);
    if (run.receipts?.some(r => r.committed && (!Number.isSafeInteger(r.revision) || r.revision > run.finalRevision))) failures.push("receipt revision exceeds observed final state");
    const success = run.outcome === "completed" && run.autonomous === true && run.manualRepairs === 0 && failures.length === 0;
    if (success) successes++;
    if (run.claimedSuccess === true && !success) unsupportedSuccessClaims++;
    if (failures.length) problems.push(`${task.id}: ${failures.join("; ")}`);
  }
  const passed = runs.size === 20 && successes >= manifest.minimumSuccesses && unsupportedSuccessClaims <= manifest.maximumUnsupportedSuccessClaims && !problems.some(p => p.startsWith("Manifest") || p.startsWith("Unknown/duplicate"));
  return { passed, target:report.target, attempted:runs.size, successes, unsupportedSuccessClaims, problems, limitation:"This validates the evidence record; a reviewer must verify the meaning of rendered/visual and real-provider evidence. It does not execute missing cases or substitute mocked-provider tests." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportPath,evidenceRoot] = process.argv.slice(2);
  if (!reportPath || !evidenceRoot) throw new Error("Usage: node scripts/check-editor-agent-qa.mjs <report.json> <evidence-directory>");
  const manifest = JSON.parse(await fs.readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8"));
  const report = JSON.parse(await fs.readFile(reportPath,"utf8"));
  const result = await checkReport({ manifest, report, evidenceRoot });
  console.log(JSON.stringify(result,null,2));
  if (!result.passed) process.exitCode = 1;
}
