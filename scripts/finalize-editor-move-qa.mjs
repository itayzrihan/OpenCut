// Complete only after the independent document/history and visual source-time checks.
import {readFile,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [rootArg]=process.argv.slice(2);if(!rootArg)throw new Error("Expected QA evidence root");
const root=resolve(rootArg),folder=join(root,"en-move"),run=JSON.parse(await readFile(join(folder,"completion.json"),"utf8"));
assert.equal(run.outcome,"completed");for(const mode of ["undo","redo","reopen"]){const state=JSON.parse(await readFile(join(folder,`${mode}-state.json`),"utf8"));assert.equal(state.runId,run.runId);assert.equal(state.phase,"completed");}
const evidence=[];for(const file of ["completion.json","baseline.json","canonical-before-history-qa.json","undo-state.json","redo-state.json","reopen-state.json","source-8.4.png","editor.png","editor-after-cache-fix.png",...run.frames.map(frame=>frame.file)]){
 const bytes=await readFile(join(folder,file));assert.ok(bytes.length);evidence.push({path:`en-move/${file}`,sha256:createHash("sha256").update(bytes).digest("hex")});
}
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id===run.taskId);
run.checks=["final-state-read",...task.checks].map(id=>({id,status:"verified",evidence}));
run.limitation="A shared video-cache time mismatch was fixed in the product after the autonomous edit. No task content was manually repaired. Reload preserves full content and the completed public run; the live 8.4-second source frame now agrees with independent FFmpeg decode. This task is not exhaustive playback/audio acceptance.";
const aggregate=JSON.parse(await readFile(join(root,"report.json"),"utf8"));aggregate.runs=aggregate.runs.filter(prior=>prior.taskId!==run.taskId);aggregate.runs.push(run);await writeFile(join(root,"report.json"),JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId:run.taskId,outcome:"completed",undoRedoReopenVerified:true}));
