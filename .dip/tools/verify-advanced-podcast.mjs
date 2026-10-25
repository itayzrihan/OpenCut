import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args,cwd=root) {
 const r=spawnSync(command,args,{cwd,stdio:'inherit'});
 if(r.error)throw r.error;
 if(r.status!==0)process.exit(r.status??1);
}
// Use the production WASM packages built by classic's normal build:wasm/prebuild.
run('node',['classic/scripts/verify-wasm-exports.mjs']);
run('cargo',['test','-p','podcast','--lib']);
run('cargo',['test','-p','opencut-editor-api','--test','classic_advanced_podcast','--test','classic_multicam']);
run('node',['classic/scripts/test-web.mjs',
 'src/podcast-sync/__tests__/advanced-engine.test.ts',
 'src/podcast-sync/__tests__/advanced-worker.test.ts',
 'src/podcast-sync/__tests__/unified-engine.test.ts',
 'src/podcast-sync/energy-reader.test.ts',
 'src/podcast-sync/sync-jobs.test.ts',
 'src/podcast-sync/precision.integration.test.ts',
 'src/core/__tests__/canonical-advanced-podcast.test.ts',
 'src/core/__tests__/canonical-multicam.test.ts',
 'src/core/__tests__/canonical-podcast.test.ts',
 'src/services/local-drive/__tests__/server.test.ts']);
run('node',['classic/node_modules/typescript/bin/tsc','--noEmit','-p','classic/apps/web/tsconfig.build.json']);
run('bunx',['eslint','src/podcast-sync/engine.ts','src/podcast-sync/sync.worker.ts','src/podcast-sync/components/podcast-sync-dialog.tsx'],root+'classic/apps/web');
