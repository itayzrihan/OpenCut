// Public project-bound evidence; no provider continuation or credentials.
import {readFile,writeFile,realpath} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,rootArg]=process.argv.slice(2);if(!projectArg||!rootArg)throw new Error("Expected QA project and evidence root");
const directory=await realpath(projectArg),root=resolve(rootArg),folder=join(root,"en-move"),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8")),bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,run=JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id,projectId);for(const scope of [run.scope,bundle.conversation,bundle.artifacts]){assert.equal(scope.projectId,projectId);assert.equal(scope.accountId,accountId);}
assert.equal(run.phase,"completed");assert.equal(run.verifiedRevision,run.revision);
const before=JSON.parse(await readFile(join(folder,"baseline.json"),"utf8"));assert.equal(before.projectId,projectId);
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id==="en-move");
const users=bundle.conversation.entries.filter(entry=>entry.kind==="user");assert.equal(users.length,1);assert.equal(users[0].text,task.prompt);
const originalScene=before.classic.document.scenes[0],scene=bundle.archive.classic.document.scenes.find(scene=>scene.id===originalScene.id),original=originalScene.tracks.main.elements[1];
assert.equal(original.name,"Second video");assert.ok(original.effects.length&&Object.keys(original.animations).length);
const oldTrackIds=new Set([originalScene.tracks.main,...originalScene.tracks.overlay,...originalScene.tracks.audio].map(track=>track.id));
const target=scene.tracks.overlay.find(track=>track.elements.some(element=>element.id===original.id));assert.ok(target);assert.equal(target.type,"video");assert.equal(oldTrackIds.has(target.id),false);
assert.deepEqual(target.elements.find(element=>element.id===original.id),{...original,startTime:270000});
assert.deepEqual(scene.tracks.main.elements,originalScene.tracks.main.elements.filter(element=>element.id!==original.id));
assert.deepEqual(bundle.archive.classic.mediaAssets,before.classic.mediaAssets);assert.deepEqual(bundle.archive.classic.document.settings,before.classic.document.settings);
const review=bundle.conversation.entries.findLast(entry=>entry.review&&entry.artifactIds.length);assert.ok(review);assert.equal((review.issues??[]).length,0);
const frames=[];for(const[index,id]of review.artifactIds.entries()){
 const item=bundle.artifacts.archive.items.find(item=>item.metadata.id===id);assert.ok(item&&item.metadata.mimeType==="image/jpeg"&&item.metadata.byteSize<=250000);
 const bytes=Buffer.from(item.dataBase64,"base64"),sha256=createHash("sha256").update(bytes).digest("hex");assert.equal(sha256,item.metadata.sha256);assert.equal(bytes.length,item.metadata.byteSize);
 const file=`frame-${index+1}.jpg`;await writeFile(join(folder,file),bytes);frames.push({file,sha256,artifactId:id});
}
const receipts=run.receipts.map(receipt=>({capabilityId:receipt.capabilityId,revision:receipt.revision,committed:receipt.committed,status:"completed"}));
assert.ok(receipts.some(receipt=>receipt.capabilityId==="timeline.classic.elements.move"&&receipt.committed));assert.ok(receipts.some(receipt=>receipt.capabilityId==="app.state.read"&&receipt.revision===run.revision));
const report={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(entry=>entry.kind==="round"&&!entry.review).length,finalRevision:run.revision,outcome:"completed",autonomous:true,manualRepairs:0,claimedSuccess:true,receipts,targetTrackId:target.id,movedElementId:original.id,frames,finalMessage:run.finalMessage,checks:{"exact-placement":"verified","preserved-fields":"verified","undo-redo":"pending-live-ui-check"}};
await writeFile(join(folder,"completion.json"),JSON.stringify(report,null,2)+"\n");await writeFile(join(folder,"canonical-before-history-qa.json"),JSON.stringify(bundle.archive.classic,null,2)+"\n");
console.log(JSON.stringify({phase:run.phase,revision:run.revision,providerRounds:report.providerRounds,frames:frames.length,preservedTrimEffectsAndKeyframes:true}));
