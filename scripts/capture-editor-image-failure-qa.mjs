// Records the real failed attempt without promoting its output to acceptance.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,outputArg]=process.argv.slice(2);if(!projectArg||!outputArg)throw new Error("Expected project and evidence root");
const directory=await realpath(projectArg),root=resolve(outputArg),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8"));assert.equal(project.metadata.id,projectId);
const bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,cp=JSON.parse(bundle.agentCheckpoint);
assert.equal(cp.run.scope.projectId,projectId);assert.equal(cp.run.scope.accountId,accountId);assert.equal(bundle.conversation.accountId,accountId);assert.equal(cp.run.phase,"failed");
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8"));const task=manifest.tasks.find(task=>task.id==="he-image-generation");
const users=bundle.conversation.entries.filter(entry=>entry.kind==="user");assert.equal(users.length,1);assert.equal(users[0].text,task.prompt);
const activities=bundle.conversation.entries.flatMap(entry=>entry.activities??[]).filter(activity=>activity.ok&&activity.input.action==="invoke"&&["imagegen.generate","media.classic.image.inspect"].includes(activity.input.id));
const report={capturedAt:new Date().toISOString(),taskId:task.id,projectId,runId:cp.run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt and codexSubscription",model:"gpt-6-astra",providerRounds:bundle.conversation.entries.filter(entry=>entry.kind==="round"&&!entry.review).length,finalRevision:bundle.archive.revision,outcome:"failed",autonomous:true,manualRepairs:0,claimedSuccess:false,checks:[],receipts:cp.run.receipts.map(receipt=>({capabilityId:receipt.capabilityId,revision:receipt.revision,committed:receipt.committed,status:"completed"})),activities,finalMessage:cp.run.finalMessage};
const folder=join(root,"he-image-generation");await mkdir(folder,{recursive:true});await writeFile(join(folder,"failed-run.json"),JSON.stringify(report,null,2)+"\n");
const evidence={path:"he-image-generation/failed-run.json",sha256:createHash("sha256").update(await readFile(join(folder,"failed-run.json"))).digest("hex")};
report.checks=["final-state-read",...task.checks].map(id=>({id,status:"failed",evidence:[evidence]}));
const aggregate=JSON.parse(await readFile(join(root,"report.json"),"utf8"));aggregate.runs=aggregate.runs.filter(run=>run.taskId!==task.id);aggregate.runs.push(report);await writeFile(join(root,"report.json"),JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId:task.id,outcome:"failed",claim:false,generatedImages:bundle.archive.classic.mediaAssets.length}));
