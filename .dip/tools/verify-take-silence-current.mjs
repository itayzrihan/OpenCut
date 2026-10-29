import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const folder=resolve('.local/take-silence-current-2026-10-29');
function run(command,args,env={}) {
 const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:4*1024**2,env:{...process.env,...env}});
 assert.equal(r.status,0,r.stdout+r.stderr); console.log(r.stdout.trim());
}
run('cargo',['test','-q','-p','opencut-editor-api','--test','classic_takes'],{
 OPENCUT_CURRENT_SILENCE_FIXTURE:resolve(folder,'project-before.json'),
 OPENCUT_CURRENT_SILENCE_EVIDENCE:resolve(folder,'audio-evidence.json'),
 OPENCUT_CURRENT_SILENCE_RESULT:resolve(folder,'cleaned-test.json')
});
run('node',['classic/scripts/test-web.mjs','src/timeline/__tests__/smart-silence.test.ts','src/timeline/smart-takes/audio-evidence.test.ts',`--report=${folder}/configured-web`]);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('git',['diff','--check','--','crates/editor-api/src/operations/classic_takes','crates/editor-api/src/operations/classic_takes.rs','crates/editor-api/tests/classic_takes.rs','classic/apps/web/src/core/managers/commands.ts','classic/apps/web/src/timeline/smart-silence.ts','classic/apps/web/src/timeline/smart-takes/types.ts']);
