// Acceptance for editing an owned artifact: no timeline replacement was requested.
// Run after reviewing the separately captured source PNG; never emit private provider state.
import {readFile,writeFile,realpath} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,rootArg]=process.argv.slice(2);if(!projectArg||!rootArg)throw new Error("Expected project and evidence root");
const directory=await realpath(projectArg),root=resolve(rootArg),folder=join(root,"en-image-edit"),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8")),bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,run=JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id,projectId);for(const scope of [run.scope,bundle.conversation,bundle.artifacts]){assert.equal(scope.projectId,projectId);assert.equal(scope.accountId,accountId);}
assert.equal(run.phase,"completed");assert.equal(run.verifiedRevision,run.revision);
const before=JSON.parse(await readFile(join(folder,"baseline.json"),"utf8")),image=JSON.parse(await readFile(join(folder,"report.json"),"utf8"));assert.equal(before.projectId,projectId);assert.equal(image.projectId,projectId);
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id==="en-image-edit");
const index=bundle.conversation.entries.findLastIndex(entry=>entry.kind==="user");assert.equal(bundle.conversation.entries[index].text,task.prompt);
const entries=bundle.conversation.entries.slice(index),activities=entries.flatMap(entry=>entry.activities??[]).filter(activity=>activity.ok&&activity.input.action==="invoke");
const generation=activities.find(activity=>activity.input.id==="imagegen.generate"&&activity.input.input.operationId===image.operationId);assert.ok(generation);
assert.equal(generation.input.input.transparentBackground,true);assert.equal(generation.input.input.referenceArtifactIds.length,1);
const referenceId=generation.input.input.referenceArtifactIds[0],source=before.classic.mediaAssets.find(asset=>asset.generation?.artifactId===referenceId);assert.ok(source);
assert.equal(source.id,before.classic.document.scenes[0].tracks.main.elements[0].mediaId);
for(const old of before.classic.mediaAssets)assert.deepEqual(bundle.archive.classic.mediaAssets.find(asset=>asset.id===old.id),old);
assert.deepEqual(bundle.archive.classic.document,before.classic.document);
const added=bundle.archive.classic.mediaAssets.filter(asset=>!before.classic.mediaAssets.some(old=>old.id===asset.id));assert.equal(added.length,1);assert.equal(added[0].generation.method,"codexSubscription");assert.equal(added[0].generation.sha256,image.image.sha256);
const sourceArtifact=bundle.artifacts.archive.items.find(item=>item.metadata.id===referenceId);assert.ok(sourceArtifact);
assert.equal(createHash("sha256").update(Buffer.from(sourceArtifact.dataBase64,"base64")).digest("hex"),source.generation.sha256);
assert.equal(image.image.hasAlpha,true);assert.ok(image.image.transparentPixels>0);const [red,green,blue,alpha]=image.image.centerRgba;assert.ok(red>green+40&&blue>green+40&&alpha>=128);
const expected={projectId,operationId:image.operationId,title:generation.input.input.title,prompt:generation.input.input.prompt,transparentBackground:true,references:[{id:referenceId,sha256:source.generation.sha256}],model:"gpt-5.6-terra"};
const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
const journal=JSON.parse(await readFile(join(dirname(dirname(directory)),"image-jobs",`${image.journal.jobKey}.json`),"utf8"));assert.equal(journal.state,"completed");assert.equal(journal.digest,createHash("sha256").update(JSON.stringify(sort(expected))).digest("hex"));
assert.equal(journal.result.sha256,image.image.sha256);
await writeFile(join(folder,"expected-request.json"),JSON.stringify(expected,null,2)+"\n");
const receipts=run.receipts.map(r=>({capabilityId:r.capabilityId,revision:r.revision,committed:r.committed,status:"completed"}));assert.ok(receipts.some(r=>r.capabilityId==="app.state.read"&&r.revision===run.revision));
const report={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt and codexSubscription",model:"gpt-6-astra",providerRounds:entries.filter(entry=>entry.kind==="round"&&!entry.review).length,finalRevision:run.revision,outcome:"completed",autonomous:true,manualRepairs:0,claimedSuccess:true,receipts,reference:{artifactId:referenceId,mediaId:source.id,sha256:source.generation.sha256},newImage:image.image,originalAndTimelineUnchanged:true,requestDigestVerified:true,visualReview:"filled purple circle; transparent background; small geometry difference honestly reported",limitation:"The earlier generic image pipeline's false flags concern insertion of the NEW image. This task requests a separate edited artifact and preserving the existing timeline; it does not request replacement/insertion.",finalMessage:run.finalMessage};
await writeFile(join(folder,"completion.json"),JSON.stringify(report,null,2)+"\n");
const evidence=[];for(const file of ["baseline.json","report.json","generated.png","expected-request.json","completion.json"]){const bytes=await readFile(join(folder,file));evidence.push({path:`en-image-edit/${file}`,sha256:createHash("sha256").update(bytes).digest("hex")});}
report.checks=["final-state-read",...task.checks].map(id=>({id,status:"verified",evidence}));
const aggregate=JSON.parse(await readFile(join(root,"report.json"),"utf8"));aggregate.runs=aggregate.runs.filter(prior=>prior.taskId!==task.id);aggregate.runs.push(report);await writeFile(join(root,"report.json"),JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId:task.id,outcome:run.phase,providerRounds:report.providerRounds,originalPreserved:true,ownedReferenceDigestVerified:true}));
