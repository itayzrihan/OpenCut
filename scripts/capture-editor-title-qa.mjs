// Public evidence only: no provider checkpoint state, credentials or private reasoning.
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg || !outputArg) throw new Error("Expected QA project directory and output directory");
const directory = await realpath(projectArg), projectId = basename(directory), accountId = basename(dirname(dirname(directory)));
const project = JSON.parse(await readFile(join(directory,"project.json"),"utf8"));
assert.equal(project.metadata.id,projectId);
const bundle = JSON.parse(project.__opencutEditorSession).saved.bundle;
const checkpoint = JSON.parse(bundle.agentCheckpoint);
for (const scope of [checkpoint.run.scope,bundle.conversation,bundle.artifacts]) {
  assert.equal(scope.accountId,accountId); assert.equal(scope.projectId,projectId);
}
assert.equal(checkpoint.run.phase,"completed");
const manifest = JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8"));
const task = manifest.tasks.find(task=>task.id==="he-basic-title");
const users = bundle.conversation.entries.filter(entry=>entry.kind==="user");
assert.equal(users.length,1); assert.equal(users[0].text,task.prompt);
const classic = bundle.archive.classic;
const clips = classic.document.scenes.flatMap(scene=>[scene.tracks.main,...scene.tracks.overlay,...scene.tracks.audio].flatMap(track=>track.elements));
assert.equal(clips.length,1);
const title=clips[0];
assert.equal(title.type,"text"); assert.equal(title.params.content,"בדיקת עריכה");
assert.equal(title.startTime,0); assert.equal(title.duration,360000);
const review=bundle.conversation.entries.findLast(entry=>entry.review && entry.artifactIds.length);
assert.ok(review && review.artifactIds.length>=3 && (review.issues ?? []).length===0);
assert.equal(checkpoint.run.verifiedRevision,checkpoint.run.revision);
const output=resolve(outputArg); await mkdir(output,{recursive:true});
const frames=[];
for (const [index,id] of review.artifactIds.entries()) {
  const item=bundle.artifacts.archive.items.find(item=>item.metadata.id===id);
  assert.ok(item && item.metadata.mimeType==="image/jpeg" && item.metadata.byteSize<=250000 && item.dataBase64.length<=350000);
  const bytes=Buffer.from(item.dataBase64,"base64"), sha256=createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256,item.metadata.sha256); assert.equal(bytes.length,item.metadata.byteSize);
  const file=`frame-${index+1}.jpg`; await writeFile(join(output,file),bytes);
  frames.push({file,artifactId:id,sha256});
}
const receipts=checkpoint.run.receipts.map(receipt=>({capabilityId:receipt.capabilityId,callId:receipt.callId,revision:receipt.revision,committed:receipt.committed,status:"completed"}));
assert.ok(receipts.some(receipt=>receipt.capabilityId==="timeline.classic.elements.insert" && receipt.committed));
assert.ok(receipts.some(receipt=>receipt.capabilityId==="app.state.read" && receipt.revision===checkpoint.run.revision));
const report={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:checkpoint.run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(entry=>entry.kind==="round" && !entry.review).length,outcome:"completed",autonomous:true,manualRepairs:0,claimedSuccess:false,finalRevision:checkpoint.run.revision,exactPromptVerified:true,title,receipts,frames,reviewSummary:review.summary,finalMessage:checkpoint.run.finalMessage,checks:{"final-state-read":"verified","text-content":"verified","exact-duration":"verified","render-visible":"pending-external-visual-review","undo-redo":"pending-live-ui-check"}};
await writeFile(join(output,"completion.json"),JSON.stringify(report,null,2)+"\n");
await writeFile(join(output,"canonical-before-history-qa.json"),JSON.stringify(classic,null,2)+"\n");
console.log(JSON.stringify({taskId:report.taskId,phase:report.outcome,revision:report.finalRevision,providerRounds:report.providerRounds,frames:frames.length,undoRedoVerified:false}));
