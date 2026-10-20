import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:6*1024*1024});if(result.status!==0)throw Error(`${command}: ${result.stdout}\n${result.stderr}`);console.log(result.stdout.trim());}
run('cargo',['test','-p','opencut-editor-api','--test','classic_teleprompter','--test','classic_podcast','--test','classic_podcast_reference','--test','classic_podcast_editorial','--test','classic_teaser_editorial','--test','classic_takes','--quiet']);
run('node',['classic/scripts/test-web.mjs','src/ai/__tests__/podcast-editorial.test.ts','src/ai/__tests__/teleprompter-controls.test.tsx','src/ai/__tests__/podcast-task.test.ts','src/ai/__tests__/podcast-plan.test.ts','src/ai/podcast-plan-cache.test.ts','src/ai/__tests__/timeline-tools.test.ts','src/core/__tests__/canonical-podcast.test.ts','--jobs=1','--report=.local/teleprompter-cuts-2026-10-20/configured-host-tests']);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check']);
const live=JSON.parse(await readFile('analysis/teleprompter-cuts-2026-10-20/live-verification.json','utf8'));
assert(live.buttonVisible&&live.followsChronological&&live.currentProjectExact&&live.currentMediaExact&&live.mcpExposesTeleprompter);
const current=JSON.parse(await readFile(join(homedir(),'Library/Application Support/OpenCut Local/current.json'),'utf8'));
assert.equal(current.id,live.productionRelease);assert((await fetch('http://localhost:3211')).ok);
console.log(JSON.stringify({passed:true,productionRelease:current.id,sourcePreserved:true,teleprompterUi:true}));
