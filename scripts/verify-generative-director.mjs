import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),web=path.join(root,'classic/apps/web');
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,encoding:'utf8',stdio:'inherit'});if(result.status!==0)throw new Error(`${command} failed (${result.status})`);}
run('cargo',['test','-p','opencut-editor-api','--lib','director_state_is_canonical','--quiet']);
run('cargo',['test','-p','opencut-editor-api','--test','generative_host','--quiet']);
run('cargo',['test','-p','opencut-mcp','--test','generative_discovery','--quiet']);
for(const file of ['server/provider.test.ts','server/shares.test.ts','server/request.test.ts','server/probe.test.ts','chat-response.test.ts','result-import.test.ts','canonical-session.test.ts','server/mcp.test.ts','host-effect.test.ts','mcp-session.test.ts'])run('bun',['test','src/generative/'+file],web);
run('bunx',['eslint','src/generative','src/app/api/generative','src/components/editor/panels/assets/assets-panel-store.tsx','src/components/editor/panels/assets/index.tsx','src/components/editor/panels/assets/views/assets.tsx'],web);
run('bunx',['tsc','-p','tsconfig.build.json','--noEmit','--pretty','false'],web);
const panel=readFileSync(path.join(web,'src/components/editor/panels/assets/assets-panel-store.tsx'),'utf8');if(!panel.includes('"ai",\n\t"generative",'))throw new Error('Generative must immediately follow AI');
console.log('Verified canonical Director/WASM, paid gate, IO, expiry, original timing, response protocol, idempotent Media import, lint and production TypeScript. No real paid call or credential access.');
