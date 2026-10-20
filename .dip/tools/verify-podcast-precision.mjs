import {spawnSync} from 'node:child_process';
for(const [cmd,args] of [
 ['cargo',['test','-p','podcast','--lib','--no-default-features']],
 ['cargo',['test','-p','opencut-editor-api','--test','classic_multicam','--test','classic_remove','--no-default-features']],
 ['node',['classic/scripts/test-web.mjs','src/podcast-sync/precision.integration.test.ts','src/podcast-sync/energy-reader.test.ts','src/podcast-sync/sync-jobs.test.ts','src/core/__tests__/canonical-multicam.test.ts','--jobs=1','--timeout=240000']],
]) {const r=spawnSync(cmd,args,{stdio:'inherit',timeout:300000});if(r.status!==0)process.exit(r.status??1);}
