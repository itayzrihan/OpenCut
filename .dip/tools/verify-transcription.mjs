import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run('cargo',['test','-p','opencut-editor-api','--test','classic_transcription']);
run('node',['scripts/verify-wasm-exports.mjs'],root+'classic');
run('node',['classic/scripts/test-web.mjs',
'src/core/__tests__/canonical-transcription.test.ts',
'src/core/managers/__tests__/transcription-manager.test.ts',
'src/core/managers/__tests__/project-session-lifecycle.test.ts',
'src/core/managers/__tests__/canonical-command-manager.test.ts',
'src/core/managers/__tests__/command-manager-state-revision.test.ts',
'src/transcription/windows.test.ts',
'src/transcription/overlap-reader.test.ts',
'src/services/transcription/service.test.ts',
'src/services/transcription/worker.test.ts',
'src/services/transcription/gpu-lifetime.test.ts',
'src/ai/__tests__/smart-takes-task.test.ts',
'src/subtitles/__tests__/auto-texts.test.ts','--jobs=1','--timeout=240000']);
run('bunx',['tsc','--noEmit','-p','tsconfig.build.json'],root+'classic/apps/web');
run('bunx',['eslint','src/core/managers/transcription-manager.ts','src/transcription/job.ts','src/transcription/windows.ts','src/transcription/windows.test.ts',
'src/transcription/overlap-reader.test.ts','src/ai/smart-takes-task.ts','src/ai/podcast-task.ts','src/subtitles/auto-texts.ts','src/core/managers/commands.ts','src/core/managers/project-manager.ts','src/transcription/timeline-stream.ts','src/core/__tests__/canonical-transcription.test.ts'],root+'classic/apps/web');
