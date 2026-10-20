import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:6*1024*1024});if(r.status!==0)throw Error(`${command}: ${r.stdout}\n${r.stderr}`);console.log(r.stdout.trim());}
run('cargo',['test','-p','opencut-editor-api','--test','classic_teleprompter','--test','classic_podcast','--test','classic_podcast_reference','--test','classic_podcast_editorial','--test','classic_teaser_editorial','--test','classic_takes','--quiet']);
run('node',['classic/scripts/test-web.mjs','src/ai/__tests__/podcast-editorial.test.ts','src/ai/__tests__/teleprompter-controls.test.tsx','src/ai/__tests__/podcast-task.test.ts','src/ai/__tests__/podcast-plan.test.ts','src/ai/podcast-plan-cache.test.ts','src/core/__tests__/canonical-podcast.test.ts','--jobs=1','--report=.local/teleprompter-review-fix-2026-10-20/configured-tests']);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check']);
const live=JSON.parse(await readFile('analysis/teleprompter-review-fix-2026-10-20/live-verification.json','utf8'));
assert(live.succeeded&&live.reusedTranscript&&live.resumedAnalysis&&live.outputCount>0&&live.originalScenesPreserved&&live.originalSettingsPreserved&&live.originalMediaPreserved&&live.newScenesHaveTakes&&live.externalAudioPreserved&&live.reviewOnlyCount>0&&live.reviewOnlyExcluded);
const baseline=JSON.parse(await readFile('.local/teleprompter-review-fix-2026-10-20/project-before.json','utf8'));
const projectRoot=join(homedir(),'Movies/OpenCut Accounts/data',live.accountId,'projects',live.projectId);
const saved=JSON.parse(await readFile(join(projectRoot,'project.json'),'utf8'));
for(const original of baseline.scenes)assert.deepEqual(saved.scenes.find(s=>s.id===original.id),original);
assert.deepEqual(saved.settings,baseline.settings);
assert.deepEqual(JSON.parse(await readFile(join(projectRoot,'media/index.json'),'utf8')),JSON.parse(await readFile('.local/teleprompter-review-fix-2026-10-20/media-before.json','utf8')));
const source=baseline.scenes[0].tracks.main.elements.find(e=>e.mediaId==='unified-audio-1');
assert(source.isSourceAudioEnabled&&Number.isFinite(source.params.sourceAudioOffsetSeconds));
const outputs=saved.scenes.filter(s=>!baseline.scenes.some(b=>b.id===s.id));
assert.equal(outputs.length,live.outputCount);
let reviewOnly=0;
for(const scene of outputs){
 const groups=scene.takeAssembly.plan.groups;
 assert(groups.length>0);
 const excluded=new Set(groups.flatMap((g,i)=>g.reviewOnly?[i]:[]));reviewOnly+=excluded.size;
 for(const clip of scene.tracks.main.elements.filter(e=>e.type==='video')){
  assert(!excluded.has(clip.takeGroup.groupIndex));
  assert.equal(clip.mediaId,source.mediaId);assert.equal(clip.isSourceAudioEnabled,true);
  for(const key of ['sourceAudioOffsetSeconds','volume','gainDb','noiseReduction','hardLimiterEnabled'])assert.equal(clip.params[key],source.params[key]);
 }
 const expectedWords=groups.filter(g=>!g.reviewOnly).reduce((sum,g)=>sum+g.alternatives[g.selected].parts.reduce((n,p)=>n+p.lastWord-p.firstWord+1,0),0);
 for(const track of scene.tracks.overlay.filter(t=>t.captionSource))assert.equal(track.captionSource.words.length,expectedWords);
}
assert.equal(reviewOnly,live.reviewOnlyCount);
const current=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));
assert.equal(current.id,live.productionRelease);assert((await fetch('http://localhost:3211')).ok);
console.log(JSON.stringify({passed:true,release:current.id,outputs:live.outputCount,sourcePreserved:true}));
