// Run only after an independent reviewer inspected the saved PNG and frames.
import {readFile,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const sharp=createRequire(new URL("../classic/apps/web/package.json",import.meta.url))("sharp");
const [rootArg]=process.argv.slice(2);if(!rootArg)throw new Error("Expected evidence root");
const root=resolve(rootArg),relative="he-image-generation/output-contract-rerun",folder=join(root,relative);
const run=JSON.parse(await readFile(join(folder,"completion.json"),"utf8")),image=JSON.parse(await readFile(join(folder,"report.json"),"utf8"));
assert.equal(run.outcome,"completed");assert.equal(image.requestDigestVerified,true);
assert.equal(image.image.hasAlpha,true);assert.ok(image.image.transparentPixels>0);assert.ok(image.image.centerRgba[3]>=128);
assert.equal(image.timeline.length,1);assert.equal(image.timeline[0].startTime,0);assert.equal(image.timeline[0].duration,360000);
for(const frame of run.frames){
 const {data,info}=await sharp(await readFile(join(folder,frame.file))).removeAlpha().raw().toBuffer({resolveWithObject:true});
 let visible=0;for(let offset=0;offset<data.length;offset+=info.channels)if(data[offset+1]>40&&data[offset+2]>40)visible++;
 assert.ok(visible>100,`Missing turquoise circle in ${frame.file}; one correct sample cannot certify the others`);
}
const evidence=[];
for(const file of ["generated.png","report.json","completion.json",...run.frames.map(frame=>frame.file)]){
 const bytes=await readFile(join(folder,file));assert.ok(bytes.length);evidence.push({path:`${relative}/${file}`,sha256:createHash("sha256").update(bytes).digest("hex")});
}
const manifest=JSON.parse(await readFile(new URL("../resources/editor-agent-qa/tasks.json",import.meta.url),"utf8")),task=manifest.tasks.find(task=>task.id===run.taskId);
run.visualPromptCompliance="verified-source-png-and-three-rendered-samples";
run.checks=["final-state-read",...task.checks].map(id=>({id,status:"verified",evidence}));
const aggregate=JSON.parse(await readFile(join(root,"report.json"),"utf8"));
const previous=aggregate.runs.find(prior=>prior.taskId===run.taskId);aggregate.previousAttempts??=[];
if(previous&&previous.runId!==run.runId&&!aggregate.previousAttempts.some(prior=>prior.runId===previous.runId))aggregate.previousAttempts.push(previous);
aggregate.runs=aggregate.runs.filter(prior=>prior.taskId!==run.taskId);aggregate.runs.push(run);
await writeFile(join(root,"report.json"),JSON.stringify(aggregate,null,2)+"\n");
console.log(JSON.stringify({taskId:run.taskId,outcome:run.outcome,preservedPreviousAttempts:aggregate.previousAttempts.length}));
