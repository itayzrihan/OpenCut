import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import assert from 'node:assert/strict';
for(const [cmd,args] of [
 ['cargo',['test','-p','opencut-editor-api','--test','render_queue']],
 ['bun',['run','--cwd','classic/apps/web','test','--timeout=180000','--test-timeout=90000','src/export/library-server.test.ts','src/export/queue/server.test.ts','src/core/__tests__/canonical-export.test.ts']],
 ['node',['classic/apps/web/node_modules/typescript/bin/tsc','--noEmit','--project','classic/apps/web/tsconfig.build.json']]
]){const result=spawnSync(cmd,args,{stdio:'inherit'});assert.equal(result.status,0,`${cmd} failed`);}
const root='analysis/projects-export-2026-10-28/';
const evidence=JSON.parse(readFileSync(root+'live.json','utf8'));
assert(evidence.singleDirect && evidence.batchDirect && evidence.batchQueue);
assert(evidence.perProjectSettings && evidence.sceneSelection && evidence.selectionPreserved);
assert(statSync(root+'batch-dialog.png').size>10000);
assert(evidence.outputs.length>=5);
const collisionPath='.local/projects-export-2026-10-28/outputs/Project export · בדיקה B.mp4';
assert.equal(statSync(collisionPath).size,0,'Existing destination was overwritten');
assert(evidence.jobs.some(j=>j.delivery==='direct' && / \(2\)\.mp4$/.test(j.destinationName)),'Collision-safe batch filename missing');
for(const output of evidence.outputs){
 assert(statSync(output.path).size>0);
 const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output.path],{encoding:'utf8'});
 assert.equal(probe.status,0);
 const d=JSON.parse(probe.stdout),v=d.streams.find(s=>s.codec_type==='video'),a=d.streams.find(s=>s.codec_type==='audio');
 assert(v);
 assert.equal(v.codec_name,output.codec);
 assert.equal(v.width,output.width);assert.equal(v.height,output.height);
 assert(Math.abs(Number(d.format.duration)-output.seconds)<0.15);
 assert.equal(!!a,output.audio);
}
const before=JSON.parse(readFileSync(root+'source-before.json','utf8'));
const after=JSON.parse(readFileSync(root+'source-after.json','utf8'));
for(const id of Object.keys(before)){
 assert.deepEqual(after[id].saved,before[id].saved,'Saved source changed during export');
 assert.equal(after[id].generation,before[id].generation,'Source ownership changed');
}
for(const job of evidence.jobs){assert.equal(job.status,'completed');assert.equal(job.sourceRevision,before[job.projectId].saved.editorRevision);assert.equal(job.delivery==='direct',!job.outputId);}
console.log('Selected-project settings, immutable saved-version capture, canonical direct/queue delivery, source ownership preservation, and real single/batch audio-video output verified.');
