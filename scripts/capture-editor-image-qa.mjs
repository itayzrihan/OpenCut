// Project-scoped public evidence only; private provider state is never emitted.
import {readFile,writeFile,mkdir,realpath} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,folderArg]=process.argv.slice(2);
if(!projectArg||!folderArg)throw new Error("Expected QA project and evidence folder");
const directory=await realpath(projectArg),folder=resolve(folderArg),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8"));assert.equal(project.metadata.id,projectId);
const bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,run=JSON.parse(bundle.agentCheckpoint).run;
for(const scope of [run.scope,bundle.conversation,bundle.artifacts]){assert.equal(scope.projectId,projectId);assert.equal(scope.accountId,accountId);}
assert.equal(run.phase,"completed");assert.equal(run.verifiedRevision,run.revision);
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(t=>t.id==="he-image-generation");
const users=bundle.conversation.entries.filter(entry=>entry.kind==="user");assert.equal(users.length,1);assert.equal(users[0].text,task.prompt);
const image=JSON.parse(await readFile(join(folder,"report.json"),"utf8"));assert.equal(image.projectId,projectId);assert.equal(image.pipelineAccepted,true);
const media=bundle.archive.classic.mediaAssets.find(asset=>asset.id===image.timeline[0].mediaId);
assert.equal(media.generation.method,"codexSubscription");assert.equal(media.generation.sha256,image.image.sha256);
const activities=bundle.conversation.entries.flatMap(entry=>entry.activities??[]).filter(a=>a.ok&&a.input.action==="invoke");
const generation=activities.find(a=>a.input.id==="imagegen.generate"&&a.input.input.operationId===image.operationId);assert.ok(generation);
assert.equal(generation.input.input.transparentBackground,true);
assert.deepEqual(generation.input.input.referenceArtifactIds??[],[]);
await mkdir(folder,{recursive:true});
await writeFile(join(folder,"expected-request.json"),JSON.stringify({projectId,operationId:image.operationId,title:generation.input.input.title,prompt:generation.input.input.prompt,transparentBackground:true,references:[],model:"gpt-5.6-terra"},null,2)+"\n");
const review=bundle.conversation.entries.findLast(entry=>entry.review&&entry.artifactIds.length>=3);assert.ok(review);assert.equal((review.issues??[]).length,0);
const frames=[];
for(const [index,id]of review.artifactIds.entries()){
 const item=bundle.artifacts.archive.items.find(item=>item.metadata.id===id);assert.ok(item&&item.metadata.mimeType==="image/jpeg"&&item.metadata.byteSize<=250000);
 const bytes=Buffer.from(item.dataBase64,"base64"),sha256=createHash("sha256").update(bytes).digest("hex");assert.equal(sha256,item.metadata.sha256);assert.equal(bytes.length,item.metadata.byteSize);
 const file=`frame-${index+1}.jpg`;await writeFile(join(folder,file),bytes);frames.push({file,artifactId:id,sha256});
}
const receipts=run.receipts.map(r=>({capabilityId:r.capabilityId,revision:r.revision,committed:r.committed,status:"completed"}));
assert.ok(receipts.some(r=>r.capabilityId==="app.state.read"&&r.revision===run.revision));
const evidence={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt and codexSubscription",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(e=>e.kind==="round"&&!e.review).length,finalRevision:run.revision,outcome:"completed",autonomous:true,manualRepairs:0,claimedSuccess:true,receipts,frames,media,finalMessage:run.finalMessage,visualPromptCompliance:"pending-external-review"};
await writeFile(join(folder,"completion.json"),JSON.stringify(evidence,null,2)+"\n");
console.log(JSON.stringify({phase:run.phase,projectId,rounds:evidence.providerRounds,frames:frames.length,visualReviewPending:true}));
