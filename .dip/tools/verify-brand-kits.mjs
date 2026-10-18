import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args, cwd = root) {
 const result = spawnSync(command,args,{cwd,stdio:'inherit',env:process.env,timeout:480000});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
run('cargo',['test','-p','opencut-editor-api','--test','brand_kits']);
run('node',['classic/scripts/test-web.mjs','--jobs=3','--timeout=240000','--report=.local/brand-kit/configured-check','src/brand-kits/server.test.ts','src/ai/__tests__/full-auto-edit-takes.test.ts','src/ai/__tests__/full-auto-edit-resume.test.ts','src/batch/server.test.ts','src/batch/worker.test.ts','src/batch/scene-checkpoint.test.ts']);
run('bun',['x','tsc','--noEmit','--pretty','false'],path.join(root,'classic/apps/web'));
