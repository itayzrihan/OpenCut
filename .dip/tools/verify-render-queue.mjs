import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import assert from 'node:assert/strict';
for(const [cmd,args] of [
 ['cargo',['test','-p','opencut-editor-api','--test','render_queue']],
 ['bun',['run','--cwd','classic/apps/web','test','--test-timeout=30000','src/export/queue/server.test.ts']],
 ['node',['classic/apps/web/node_modules/typescript/bin/tsc','--noEmit','--project','classic/apps/web/tsconfig.build.json']]
]){const result=spawnSync(cmd,args,{stdio:'inherit'});assert.equal(result.status,0,`${cmd} failed`);}
const evidence=JSON.parse(readFileSync('analysis/render-queue-2026-10-28/live.json','utf8'));
assert(evidence.jobs.length>=2);
assert.equal(evidence.editWhileRendering,true);
const during=JSON.parse(readFileSync('analysis/render-queue-2026-10-28/after-live-edit.json','utf8'));
const active=during.jobs.find(j=>j.status==='rendering');
assert(active && active.progress>0 && active.progress<1);
const finished=evidence.jobs.find(j=>j.id===active.id);
assert(finished.createdAtMs<during.atMs && during.atMs<finished.updatedAtMs);
const playback=JSON.parse(readFileSync('analysis/render-queue-2026-10-28/playback.json','utf8'));
assert(playback.isPlaying && playback.currentTime>0);
assert(evidence.matchedFrameRms<3);
assert.equal(evidence.downloadVerified,true);
assert.equal(evidence.playbackWhileRendering,true);
assert.equal(evidence.sourceRestored,true);
assert.equal(evidence.queueSurvivedReload,true);
for(const job of evidence.jobs){
 assert.equal(job.status,'completed');
 assert(statSync(job.outputPath).size>0);
 const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',job.outputPath],{encoding:'utf8'});
 assert.equal(probe.status,0);
 const data=JSON.parse(probe.stdout);
 assert(Math.abs(Number(data.format.duration)-job.expectedSeconds)<0.15);
 const video=data.streams.find(s=>s.codec_type==='video');
 const audio=data.streams.find(s=>s.codec_type==='audio');
 assert(video && audio,'composited video and processed audio are required');
 assert(video.width>=640 && video.height>=360);
 const snapshot=job.snapshot.document.scenes.find(s=>s.id===job.sceneId);
 const tracks=[snapshot.tracks.main,...snapshot.tracks.overlay,...snapshot.tracks.audio];
 const end=Math.max(...tracks.flatMap(t=>t.elements.map(e=>e.startTime+e.duration)))/120000;
 assert.equal(end,job.expectedSeconds);
}
assert.notEqual(evidence.jobs[0].snapshotHash,evidence.jobs[1].snapshotHash);
console.log('Canonical queue lifecycle, durable host concurrency, source binding isolation, frozen output durations, audio/video output and live editing/playback verified.');
