import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
const root='.local/scene-ai-queue-2026-10-20';
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:6*1024*1024});if(r.status!==0)throw Error(`${command}: ${r.stdout}\n${r.stderr}`);console.log(r.stdout.trim());}
run('node',['--test','classic/scripts/local-production/prune-releases.test.mjs']);
run('cargo',['test','-q','-p','opencut-editor-api','--test','classic_scenes','--test','classic_export']);
run('cargo',['test','-q','--manifest-path','classic/Cargo.toml','-p','timeline','batch_edit']);
run('node',['classic/scripts/test-web.mjs','src/transcription/windows.test.ts','src/export/__tests__/audio-scratch.test.ts','src/export/__tests__/scratch.test.ts','src/export/__tests__/pcm-file.test.ts','src/export/__tests__/audio-quality.test.ts','src/export/__tests__/audio-source-windows.test.ts','src/ai/__tests__/subject-framing-source.test.ts','src/batch/server.test.ts','src/batch/worker.test.ts','src/batch/progress-view.test.ts','src/batch/scene-checkpoint.test.ts','src/ai/__tests__/full-auto-edit-resume.test.ts','src/ai/__tests__/full-auto-edit-takes.test.ts','src/core/__tests__/canonical-scene-automation.test.ts','src/ai/__tests__/timeline-document-v2.test.ts','src/core/managers/__tests__/playback-manager.test.ts','src/core/managers/__tests__/playback-preparation.test.ts','src/core/managers/__tests__/timeline-manager-preview.test.ts','src/services/storage/__tests__/project-source-roundtrip.test.ts','--jobs=1',`--report=${root}/configured-tests`]);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check']);
const evidence=JSON.parse(await readFile('analysis/scene-ai-queue-2026-10-20/live-verification.json','utf8'));
assert(evidence.batchSelected&&evidence.waitingShown&&evidence.switchedDuringWork&&evidence.reloadResumed&&evidence.completedJobs.length>=2);
const before=JSON.parse(await readFile(`${root}/project-before.json`,'utf8'));
const account=join(homedir(),'Movies/OpenCut Accounts/data',evidence.accountId);
const saved=JSON.parse(await readFile(join(account,'projects',evidence.projectId,'project.json'),'utf8'));
for(const scene of before.scenes)assert.deepEqual(saved.scenes.find(s=>s.id===scene.id),scene);
assert.deepEqual(saved.settings,before.settings);
const queue=JSON.parse(await readFile(join(account,'batch/queue.json'),'utf8'));
for(const id of evidence.completedJobs){
 const run=queue.runs.find(r=>r.id===id);assert(run&&run.jobs.every(j=>j.status==='completed'));
 const intent=saved.automationEdits.find(j=>j.id===id);assert.equal(intent.status,'published');
 const scene=saved.scenes.find(s=>s.id===intent.outputSceneId);assert(scene&&scene.tracks.main.elements.length>0);
 assert.equal(scene.settings.canvasSize.width,1080);assert.equal(scene.settings.canvasSize.height,1920);
 assert(scene.tracks.overlay.some(t=>t.captionSource?.words.length>0));
 for(const clip of scene.tracks.main.elements.filter(e=>e.type==='video')){assert.equal(clip.mediaId,'unified-audio-1');assert.equal(clip.isSourceAudioEnabled,true);assert.equal(clip.params.sourceAudioOffsetSeconds,-9.396641024850526);}
}
const current=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));
const sourceHash=createHash('sha256');
const sourceFiles=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{maxBuffer:64*1024**2}).toString().split('\0').filter(Boolean).sort();
for(const file of sourceFiles){
 if(file.endsWith('/next-env.d.ts'))continue;
 if(!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file))continue;
 sourceHash.update(file);
 try{sourceHash.update(await readFile(file));}catch(error){if(error.code==='ENOENT')sourceHash.update('deleted');else throw error;}
}
assert.equal(current.fingerprint,sourceHash.digest('hex'),'Deployed editor must match current product source');
assert.equal(current.id,evidence.productionRelease);assert((await fetch('http://localhost:3211')).ok);
console.log(JSON.stringify({passed:true,sourceScenes:before.scenes.length,completed:evidence.completedJobs.length,release:current.id}));
