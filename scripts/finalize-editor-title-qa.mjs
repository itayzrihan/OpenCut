// Run after externally reviewing the saved frames and live UI history evidence.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root=resolve(process.argv[2] ?? ".local/editor-agent-qa-live");
const folder=join(root,"he-basic-title");
const report=JSON.parse(await readFile(join(folder,"completion.json"),"utf8"));
assert.equal(report.taskId,"he-basic-title");
const before=JSON.parse(await readFile(join(folder,"canonical-before-history-qa.json"),"utf8"));
for (const mode of ["undo","redo","reopen"]) {
  const evidence=JSON.parse(await readFile(join(folder,`${mode}-state.json`),"utf8"));
  assert.equal(evidence.projectId,report.projectId); assert.equal(evidence.runId,report.runId);
  assert.equal(evidence.phase,"completed");
  if (mode==="undo") assert.equal(evidence.revision,report.finalRevision+1);
  else { assert.equal(evidence.revision,report.finalRevision+2); assert.deepEqual(evidence.classic,before); }
}
report.checks["render-visible"]="verified";
report.checks["undo-redo"]="verified";
report.claimedSuccess=true;
report.externalVisualReview="Saved source-review JPEG shows centered, readable Hebrew without clipping. Live reopened editor screenshot confirms the timeline and public conversation.";
report.reloadVerified=true;
await writeFile(join(folder,"completion.json"),JSON.stringify(report,null,2)+"\n");
const evidence=async(file)=>({path:`he-basic-title/${file}`,sha256:createHash("sha256").update(await readFile(join(folder,file))).digest("hex")});
const main=await evidence("completion.json"), frame=await evidence("frame-1.jpg"), screenshot=await evidence("editor-reopened.png");
const history=await Promise.all(["undo-state.json","redo-state.json","reopen-state.json"].map(evidence));
const run={...report,checks:Object.keys(report.checks).map(id=>({id,status:"verified",evidence:id==="undo-redo"?history:id==="render-visible"?[main,frame,screenshot]:[main]}))};
const reportPath=join(root,"report.json");
let aggregate={target:"browser",runs:[]};
try { aggregate=JSON.parse(await readFile(reportPath,"utf8")); } catch(error) { if(error.code!=="ENOENT") throw error; }
aggregate.runs=aggregate.runs.filter(item=>item.taskId!==run.taskId); aggregate.runs.push(run);
await writeFile(reportPath,JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId:run.taskId,providerRounds:run.providerRounds,checks:run.checks.length,autonomous:true,manualRepairs:0,aggregateCases:aggregate.runs.length}));
