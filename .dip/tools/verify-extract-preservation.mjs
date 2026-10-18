import {spawnSync} from 'node:child_process';
for (const [cmd,args] of [
 ['bun',['.dip/tools/check-extract-caption-isolation.ts']],
 ['cargo',['test','-p','opencut-editor-api','--test','classic_podcast','--test','classic_transcription','--test','classic_update','--test','classic_archive']],
 ['node',['classic/scripts/test-web.mjs','src/ai/__tests__/podcast-task.test.ts','src/ai/__tests__/podcast-plan.test.ts','src/core/managers/__tests__/canonical-command-manager.test.ts','--timeout=240000','--test-timeout=120000','--jobs=1']]
]) { const r=spawnSync(cmd,args,{stdio:'inherit'}); if(r.status!==0)process.exit(r.status??1); }
