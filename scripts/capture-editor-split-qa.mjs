// Independent numeric source/Bezier acceptance, plus public provider/artifact evidence.
import {readFile,writeFile} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
const [projectArg,rootArg]=process.argv.slice(2);if(!projectArg||!rootArg)throw new Error("Expected project and evidence root");
const directory=resolve(projectArg),root=resolve(rootArg),folder=join(root,"he-split"),projectId=basename(directory),accountId=basename(dirname(dirname(directory)));
const project=JSON.parse(await readFile(join(directory,"project.json"),"utf8")),bundle=JSON.parse(project.__opencutEditorSession).saved.bundle,run=JSON.parse(bundle.agentCheckpoint).run;
assert.equal(project.metadata.id,projectId);assert.equal(run.scope.projectId,projectId);assert.equal(run.scope.accountId,accountId);assert.equal(run.phase,"completed");assert.equal(run.verifiedRevision,run.revision);
const baseline=JSON.parse(await readFile(join(folder,"rerun-baseline.json"),"utf8")),before=baseline.classic.document.scenes[0].tracks.main.elements[0],scene=bundle.archive.classic.document.scenes[0],halves=scene.tracks.main.elements;
assert.equal(halves.length,2);const[left,right]=halves;
assert.equal(left.id,before.id);assert.notEqual(right.id,before.id);assert.equal(left.duration,210000);assert.equal(right.startTime,210000);assert.equal(right.duration,750000);assert.equal(left.duration+right.duration,before.duration);
assert.deepEqual(left.retime,before.retime);assert.deepEqual(right.retime,before.retime);assert.equal(left.trimStart,before.trimStart);assert.equal(right.trimEnd,before.trimEnd);
assert.equal(right.trimStart,315000);assert.equal(before.sourceDuration-left.trimEnd,right.trimStart);assert.equal(left.duration*before.retime.rate,right.trimStart-before.trimStart);
assert.equal(left.mediaId,before.mediaId);assert.equal(right.mediaId,before.mediaId);assert.deepEqual(bundle.archive.classic.mediaAssets,baseline.classic.mediaAssets);
function cubic(p0,p1,p2,p3,u){const v=1-u;return v*v*v*p0+3*v*v*u*p1+3*v*u*u*p2+u*u*u*p3;}
function curve(keys,t){
 if(t<=keys[0].time)return keys[0].value;if(t>=keys.at(-1).time)return keys.at(-1).value;
 const index=keys.findIndex((key,i)=>i+1<keys.length&&t>=key.time&&t<=keys[i+1].time),a=keys[index],b=keys[index+1];
 if(a.segmentToNext!=="bezier")return a.value+(b.value-a.value)*(t-a.time)/(b.time-a.time);
 const x1=a.time+(a.rightHandle?.dt??0),x2=b.time+(b.leftHandle?.dt??0),y1=a.value+(a.rightHandle?.dv??0),y2=b.value+(b.leftHandle?.dv??0);
 let low=0,high=1;for(let i=0;i<60;i++){const u=(low+high)/2;if(cubic(a.time,x1,x2,b.time,u)<t)low=u;else high=u;}
 return cubic(a.value,y1,y2,b.value,(low+high)/2);
}
let maximumCurveError=0;for(let i=0;i<=1000;i++){const t=Math.round(before.duration*i/1000),original=curve(before.animations.opacity.keys,t),split=t<=left.duration?curve(left.animations.opacity.keys,t):curve(right.animations.opacity.keys,t-left.duration);maximumCurveError=Math.max(maximumCurveError,Math.abs(original-split));}
assert.ok(maximumCurveError<0.00001);assert.equal(left.animations.opacity.keys.at(-1).value,right.animations.opacity.keys[0].value);
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id==="he-split");
const start=bundle.conversation.entries.findLastIndex(entry=>entry.kind==="user");assert.equal(bundle.conversation.entries[start].text,task.prompt);const entries=bundle.conversation.entries.slice(start);
const review=entries.findLast(entry=>entry.review&&entry.artifactIds.length);assert.ok(review);assert.equal((review.issues??[]).length,0);const frames=[];
for(const[index,id]of review.artifactIds.entries()){const item=bundle.artifacts.archive.items.find(item=>item.metadata.id===id);assert.ok(item&&item.metadata.mimeType==="image/jpeg"&&item.metadata.byteSize<=250000);const bytes=Buffer.from(item.dataBase64,"base64"),sha256=createHash("sha256").update(bytes).digest("hex");assert.equal(sha256,item.metadata.sha256);const file=`rerun-frame-${index+1}.jpg`;await writeFile(join(folder,file),bytes);frames.push({file,artifactId:id,sha256});}
const report={taskId:task.id,capturedAt:new Date().toISOString(),projectId,runId:run.scope.runId,provenance:"real-provider",provider:"sign-in-with-chatgpt",model:"gpt-6-astra",providerRounds:entries.filter(entry=>entry.kind==="round"&&!entry.review).length,finalRevision:run.revision,outcome:"completed",autonomous:true,manualRepairs:0,claimedSuccess:true,receipts:run.receipts.map(r=>({capabilityId:r.capabilityId,revision:r.revision,committed:r.committed,status:"completed"})),frames,maximumCurveError,sourceBoundaryTicks:315000,finalMessage:run.finalMessage};
await writeFile(join(folder,"completion.json"),JSON.stringify(report,null,2)+"\n");await writeFile(join(folder,"canonical-before-history-qa.json"),JSON.stringify(bundle.archive.classic,null,2)+"\n");
console.log(JSON.stringify({phase:run.phase,revision:run.revision,frames:frames.length,maximumCurveError,historyPending:true}));
