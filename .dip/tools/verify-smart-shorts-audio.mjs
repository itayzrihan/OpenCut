import {spawnSync} from 'node:child_process';
for(const [cmd,args,env] of [
 ['cargo',['build','--release','-p','opencut-mcp-server'],{}],
 ['cargo',['test','-p','opencut-editor-agent','--test','session_store'],{}],
 ['node',['classic/scripts/test-web.mjs','src/editor-agent/__tests__/session-store-host.test.ts','src/editor-agent/__tests__/project-font-ownership.test.ts','src/editor-agent/__tests__/session-policy.test.ts','src/export/__tests__/pcm-file.test.ts','src/export/__tests__/audio-source-windows.test.ts'],{}],
 ['node',['classic/scripts/test-web.mjs','src/export/__tests__/streaming-browser.test.ts','--timeout=240000','--test-timeout=230000','--jobs=1'],{OPENCUT_STREAM_EXPORT_TEST:'1'}]
]){const r=spawnSync(cmd,args,{stdio:'inherit',env:{...process.env,...env}});if(r.status!==0)process.exit(r.status||1);}
