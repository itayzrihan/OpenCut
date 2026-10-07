# OpenCut live agent acceptance

`tasks.json` freezes 20 Hebrew/English tasks. These are acceptance cases, not a
record of passing runs. Prepare named fixtures in isolated local QA projects;
record media hashes, project/account ownership and starting revision. Never use
production edits as disposable fixtures. Browser and packaged Electron have
separate results. SaaS has its own later gate.

For each case save the public request/final answer, actual provider/model and
round count, scope, completed receipts, final `app.state.read`, relevant before/
after snapshots and every listed check. A render check requires viewed pixels;
state assertions alone are insufficient. Image cases require real authenticated
subscription output, decoded PNG and durable artifact/media binding. Simulated
provider tests do not count. Never replay an uncertain image dispatch.

For follow-up and recovery cases complete the first task, reload, and execute the
second request. Inspect receipts for duplicate mutations and compare restored
artifact SHA/bytes. For exports actually download the returned artifact, compare
its SHA, inspect streams using ffprobe, and decode the whole file with ffmpeg.
Use `scripts/hyperframes/check-live-run.mjs` for the saved correction scenario.

The release gate is at least 18 autonomous successes out of all 20 attempted
cases and zero unsupported success claims. Failed, blocked, unattempted and
manually repaired cases cannot count as autonomous successes. Every required
check needs its own evidence; missing evidence fails closed. A model saying
"done" without verified required checks is an unsupported success claim.

Validate a recorded run set with:

```
node scripts/check-editor-agent-qa.mjs <report.json> <evidence-directory>
```

The report contains `target` (browser or packaged-electron) and `runs`. Each run
records `taskId`, `provenance: "real-provider"`, provider/model/rounds,
projectId/runId/finalRevision, outcome, autonomous, manualRepairs, claimedSuccess,
completed capability receipts, and checks. Each verified check references local
relative evidence paths and SHA-256 digests. Include `final-state-read` alongside
all case-specific checks. The validator rejects missing/corrupt/outside evidence,
duplicate cases, mock provenance and unsupported success. Its synthetic unit
fixtures validate the gate only; they never establish live agent quality.

Current evidence is catalogued in `EDITOR-AGENT-IMPLEMENTATION.md`; the complete
20-task benchmark and packaged Electron acceptance have not passed yet.
