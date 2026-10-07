// Records an honest terminal failure, with public sampled artifacts only.
import {readFile,writeFile,mkdir,realpath} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,rootArg,taskId]=process.argv.slice(2);if(!projectArg||!rootArg||!taskId)throw new Error("Expected project, evidence root and task ID");
const directory=await realpath(projectArg),root=resolve(rootArg),folder=join(root,taskId),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id===taskId);assert.ok(task);
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8")),bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,run=JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id,projectId);assert.equal(run.scope.projectId,projectId);assert.equal(run.scope.accountId,accountId);assert.equal(run.phase,"failed");
const users=bundle.conversation.entries.filter(entry=>entry.kind==="user");assert.equal(users.length,1);assert.equal(users[0].text,task.prompt);
await mkdir(folder,{recursive:true});const frames=[];const review=bundle.conversation.entries.findLast(entry=>entry.review&&entry.artifactIds.length);
for(const[index,id]of(review?.artifactIds??[]).entries()){
 const item=bundle.artifacts.archive.items.find(item=>item.metadata.id===id);assert.ok(item&&item.metadata.mimeType==="image/jpeg"&&item.metadata.byteSize<=250000);
 const bytes=Buffer.from(item.dataBase64,"base64"),sha256=createHash("sha256").update(bytes).digest("hex");assert.equal(sha256,item.metadata.sha256);
 const file=`failed-frame-${index+1}.jpg`;await writeFile(join(folder,file),bytes);frames.push({file,sha256,artifactId:id});
}
const report={capturedAt:new Date().toISOString(),taskId,projectId,runId:run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(entry=>entry.kind==="round"&&!entry.review).length,finalRevision:run.revision,outcome:"failed",autonomous:true,manualRepairs:0,claimedSuccess:false,receipts:run.receipts.map(receipt=>({capabilityId:receipt.capabilityId,revision:receipt.revision,committed:receipt.committed,status:"completed"})),frames,finalMessage:run.finalMessage,reviewIssues:bundle.conversation.entries.filter(entry=>entry.review&&entry.issues?.length).map(entry=>entry.issues)};
await writeFile(join(folder,"failed-run.json"),JSON.stringify(report,null,2)+"\n");const bytes=await readFile(join(folder,"failed-run.json")),evidence={path:`${taskId}/failed-run.json`,sha256:createHash("sha256").update(bytes).digest("hex")};
report.checks=["final-state-read",...task.checks].map(id=>({id,status:"failed",evidence:[evidence]}));
const aggregate=JSON.parse(await readFile(join(root,"report.json"),"utf8"));aggregate.runs=aggregate.runs.filter(prior=>prior.taskId!==taskId);aggregate.runs.push(report);await writeFile(join(root,"report.json"),JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId,phase:run.phase,providerRounds:report.providerRounds,sampledFrames:frames.length,claimedSuccess:false}));
