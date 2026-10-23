import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024**2});assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);console.log(r.stdout.trim());}
run('cargo',['test','-q','-p','opencut-editor-api','--test','classic_scenes','--test','classic_takes']);
run('node',['classic/scripts/test-web.mjs','src/ai/__tests__/music-duration.test.ts','src/ai/__tests__/music-duration-real.test.ts','src/ai/__tests__/timeline-document-v2.test.ts','src/ai/__tests__/full-auto-edit-routed.test.ts','src/ai/__tests__/full-auto-edit-takes.test.ts','src/ai/__tests__/full-auto-edit-resume.test.ts','src/subtitles/__tests__/auto-texts.test.ts','src/batch/server.test.ts','src/batch/scene-checkpoint.test.ts','src/core/__tests__/canonical-scene-automation.test.ts','--jobs=2','--report=.local/background-three-2026-10-23/configured-tests']);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check']);
const evidence=JSON.parse(await readFile('analysis/background-three-2026-10-23/live-verification.json','utf8'));
assert(evidence.resultReopened&&evidence.previewAdvancedSeconds>0);
const before=JSON.parse(await readFile('.local/background-three-2026-10-23/source-before.json','utf8'));
const root=join(homedir(),'Movies/OpenCut Accounts/data',evidence.accountId);
const after=JSON.parse(await readFile(join(root,'projects',evidence.projectId,'project.json'),'utf8'));
for(const scene of before.scenes)assert.deepEqual(after.scenes.find(s=>s.id===scene.id),scene);
assert.deepEqual(after.settings,before.settings);
const queue=JSON.parse(await readFile(join(root,'batch/queue.json'),'utf8'));
assert.equal(evidence.jobIds.length,3);
for(const id of evidence.jobIds){
 const run=queue.runs.find(r=>r.id===id);assert(run&&run.jobs.every(j=>j.status==='completed'&&j.completedStages===10));
 const job=run.jobs[0];const intent=after.automationEdits.find(j=>j.id===id);assert.equal(intent.status,'published');
 const source=before.scenes.find(s=>s.id===job.sceneId);const result=after.scenes.find(s=>s.id===intent.outputSceneId);
 assert(result&&result.tracks.main.elements.length>0);assert.equal(result.settings.canvasSize.width,1080);assert.equal(result.settings.canvasSize.height,1920);
 const camera=e=>({mediaId:e.mediaId,startTime:e.startTime,duration:e.duration,trimStart:e.trimStart,trimEnd:e.trimEnd});
 const chosen=source.tracks.overlay.filter(t=>t.type==='video'&&!t.hidden).flatMap(t=>t.elements.filter(e=>e.enabled!==false&&!e.hidden)).sort((a,b)=>a.startTime-b.startTime);
 assert.deepEqual(result.tracks.main.elements.map(camera),chosen.map(camera));
 assert(result.tracks.main.elements.every(e=>e.isSourceAudioEnabled===false));
 const audio=e=>({...camera(e),params:e.params});
 for(const mic of source.tracks.audio){const output=result.tracks.audio.find(t=>t.name===mic.name);assert(output);assert.equal(output.muted,mic.muted);assert.deepEqual(output.elements.map(audio),mic.elements.map(audio));}
 assert(result.tracks.overlay.some(t=>t.captionSource?.words.length>0));
}
const current=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));
assert.equal(current.id,evidence.productionRelease);
const hash=createHash('sha256');
const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{maxBuffer:64*1024**2}).toString().split('\0').filter(Boolean).sort();
for(const file of files){if(file.endsWith('/next-env.d.ts'))continue;if(!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file))continue;hash.update(file);try{hash.update(await readFile(file));}catch(e){if(e.code==='ENOENT')hash.update('deleted');else throw e;}}
assert.equal(current.fingerprint,hash.digest('hex'));
assert((await fetch('http://localhost:3211')).ok);
console.log(JSON.stringify({passed:true,completed:3,unchangedSourceScenes:before.scenes.length,release:current.id}));
