import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run('node',['.dip/tools/verify-transcription.mjs']);
run('node',['classic/scripts/test-web.mjs','src/transcription/external-client.test.ts','src/transcription/external-server.test.ts','--jobs=1']);
run('bunx',['eslint','src/transcription/external-client.ts','src/transcription/external-server.ts','src/subtitles/components/transcription-source.tsx','src/app/api/transcription/external/route.ts','src/app/api/transcription/settings/route.ts'],root+'classic/apps/web');
