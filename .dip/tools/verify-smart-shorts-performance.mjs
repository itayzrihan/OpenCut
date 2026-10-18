import {spawnSync} from 'node:child_process';
const checks=[
 ['cargo',['test','-p','opencut-editor-api','--lib']],
 ['cargo',['test','-p','opencut-editor-api','--test','classic_history','--test','classic_archive','--test','classic_podcast','--test','classic_transcription']],
 ['cargo',['test','-p','opencut-editor-agent','--lib','--test','session_store']],
 ['node',['classic/scripts/test-web.mjs','src/accounts/server.test.ts','src/editor-agent/__tests__/session-store-host.test.ts','src/editor-agent/__tests__/project-font-ownership.test.ts','src/media/__tests__/playback-audio-cache.test.ts','src/media/__tests__/audio-sink-cache.test.ts','src/core/managers/__tests__/audio-preparation.test.ts','src/core/managers/__tests__/audio-sync.test.ts','src/core/__tests__/canonical-classic-session.test.ts','src/core/__tests__/canonical-transcription.test.ts','src/core/__tests__/canonical-podcast.test.ts','--jobs=1','--timeout=120000']],
 ['node',['.dip/tools/verify-smart-shorts-audio.mjs']]
];
for(const[command,args]of checks){const r=spawnSync(command,args,{stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
