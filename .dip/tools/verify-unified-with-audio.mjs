import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:6*1024*1024});if(result.status!==0)throw Error(`${command}: ${result.stdout}\n${result.stderr}`);console.log(result.stdout.trim());}
run('cargo',['test','-p','timeline','audio_sync::tests','--quiet']);
run('cargo',['test','-p','opencut-editor-api','--test','classic_unified','--test','classic_source_audio','--test','classic_audio_sharpen','--test','classic_insert','--test','classic_transcription','--test','classic_podcast_reference','--quiet']);
run('node',['classic/scripts/test-web.mjs','src/core/__tests__/canonical-unified-audio.test.ts','src/media/__tests__/unified-sync-task.test.ts','src/media/__tests__/unified-angles-audio.test.ts','src/media/__tests__/unified-angles.test.ts','src/podcast-sync/__tests__/unified-engine.test.ts','src/timeline/__tests__/unified-angles-cycle.test.ts','src/export/__tests__/audio-source-windows.test.ts','--jobs=1','--report=.local/unified-with-audio-2026-10-20/configured-host-tests']);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check']);
const live=JSON.parse(await readFile('analysis/unified-with-audio-2026-10-20/live-verification.json','utf8'));
assert(live.contextMenuEnabled&&live.createdCompound&&live.synced&&live.processingVerified&&live.originalScenesPreserved&&live.originalMediaPreserved&&live.reloaded&&live.playbackAdvanced&&live.angleSwitched&&live.temporarySceneRemoved&&live.finalActiveSceneIsOriginal&&live.currentSceneCount===live.sourceSceneCount&&live.originalSettingsPreserved);
const current=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));assert.equal(current.id,live.productionRelease);assert((await fetch('http://localhost:3211')).ok);
console.log(JSON.stringify({passed:true,productionRelease:current.id,assetId:live.assetId,sourcePreserved:true}));
