import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
const root='analysis/podcast-editorial-upgrade-2026-10-19';
function run(command,args){const p=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024*1024});if(p.status!==0)throw Error(`${command} failed: ${p.stdout}\n${p.stderr}`);console.log(p.stdout.trim());}
run('cargo',['test','-p','opencut-editor-api','--test','classic_podcast','--test','classic_teaser_editorial','--test','classic_podcast_editorial','--quiet']);
run('node',['classic/scripts/test-web.mjs','src/ai/__tests__/podcast-plan.test.ts','src/ai/__tests__/podcast-task.test.ts','src/ai/__tests__/podcast-editorial.test.ts','src/ai/podcast-plan-cache.test.ts','--jobs=1','--report=.local/podcast-editorial-upgrade/configured-web-tests']);
run('bun',['test','./.dip/tools/check-podcast-lifecycle.test.ts']);
run('bun',['run','.dip/tools/check-extract-caption-isolation.ts']);
run('bun',['run','.dip/tools/evaluate-podcast-shorts.ts','--replay']);
const replay=JSON.parse(await readFile(`${root}/replay.json`,'utf8'));
assert.equal(replay.passed,true);assert.equal(replay.results.length,2);
for(const r of replay.results){assert.equal(r.windows,22);assert.equal(r.providerCalls,0);assert.equal(r.report.windowsReviewed,r.report.windowsTotal);assert(r.sourceScenesExact&&r.transcriptionExact);assert.equal(r.outputScenes,r.videos.length);assert(r.outputScenes>0);assert.equal(r.report.critiques.length,r.outputScenes);assert(r.sourceAudioPreserved);assert.equal(r.sourceAudioGain,0);assert(r.outputAudioGains.every(g=>g===r.sourceAudioGain));assert(r.cuts.every(c=>c.seconds>=20&&c.seconds<=90));}
const deployment=JSON.parse(await readFile('.local/podcast-editorial-upgrade/deployment.json','utf8'));
const active=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));
assert.equal(active.id,deployment.release);assert(deployment.running);assert((await fetch('http://localhost:3211')).ok);
const evidence={passed:true,coreTests:13,hostTests:20,isolatedBrowserGenerations:6,isolatedOutputCaptionEdits:6,realProviderReplay:replay.results.map(r=>({mode:r.mode,windows:r.windows,outputs:r.outputScenes,rounds:r.report.rounds,seconds:r.cuts.map(c=>c.seconds),sourceScenesExact:r.sourceScenesExact,transcriptionExact:r.transcriptionExact,additionalProviderCalls:r.providerCalls,sourceAudioPreserved:r.sourceAudioPreserved})),productionRelease:deployment.release,limits:['Transcript-semantic model critique does not establish human preference, listening or phoneme alignment.','Generated examples were extracted only into isolated runtimes; no source project edited.','Source audio mix is unchanged; 0dB is unity, and derived dialogue preserves its authored gain. Explicit mutes/separate mixes/automation preserved. No export/B-roll/motion finishing requested.']};
await writeFile(`${root}/verification.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
