// Functional renderer test only. No browser automation or user account mutation.
import {readFile,writeFile,open,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
const base=resolve('.local/render-queue-recovery-2026-10-28/fixture');
const fixture=JSON.parse(await readFile(join(base,'fixture.json'),'utf8'));
const release=JSON.parse(await readFile(process.argv[2]||'/Users/itayzrihan/Library/Application Support/OpenCut Local/candidate.json','utf8'));
const releaseRoot=resolve(release.appRoot,'../../..');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://${process.env.OPENCUT_FIXTURE_HOST||"localhost"}:${port}`;
const log=await open(join(base,'server.log'),'a',0o600);
const server=spawn(process.execPath,[join(release.appRoot,'server.js')],{cwd:release.appRoot,env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),OPENCUT_ACCOUNTS_DIR:join(base,'accounts'),OPENCUT_RENDER_OUTPUTS_DIR:join(base,'outputs'),NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore',log.fd,log.fd]});await log.close();
let worker;process.on("SIGTERM",()=>{worker?.kill("SIGTERM");server.kill("SIGTERM");process.exit(1);});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 let ready=false;for(let i=0;i<90;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await sleep(1000);}if(!ready)throw Error('Fixture server failed to start');
 const token=randomBytes(32).toString('hex');
 const workerLog=await open(join(base,'worker.log'),'a',0o600);
 worker=spawn(join(releaseRoot,'Electron.app/Contents/MacOS/Electron'),[join(releaseRoot,'electron/render-worker.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,OPENCUT_RENDER_WORKER_PROFILE:join(base,'profile')},stdio:['pipe',workerLog.fd,workerLog.fd]});
 const spawned=new Promise((ok,fail)=>{worker.once('spawn',ok);worker.once('error',fail);});await spawned;await workerLog.close();
 await writeFile(join(fixture.root,'worker.json'),JSON.stringify({pid:worker.pid,origin,account:{id:fixture.accountId,displayName:'Isolated renderer fixture',login:'fixture'},tokenHash:createHash('sha256').update(token).digest('hex'),createdAtMs:Date.now()}),{mode:0o600});
 worker.stdin.end(JSON.stringify({origin,accountId:fixture.accountId,token,profile:join(base,'profile')}));
 console.log('Started production background renderer',worker.pid,'without any queue or editor window.');
 let jobs;
 for(let i=0;i<180;i++){
  jobs=JSON.parse(await readFile(join(fixture.root,'runtime.json'),'utf8')).active.document.renderQueue;
  if(i%10===0)console.log(jobs.map(j=>`${j.status}:${Math.round(j.progress*100)}%:${j.message}`).join(' | '));
  if(jobs.every(j=>j.status==='completed'))break;
  if(jobs.some(j=>j.status==='failed'))throw Error(jobs.find(j=>j.status==='failed').message);
  if(worker.exitCode!==null)throw Error(`Background worker exited early: ${worker.exitCode}`);
  await sleep(1000);
 }
 if(!jobs.every(j=>j.status==='completed'))throw Error('Background fixture timed out');
 const outputs=[];
 for(const job of jobs){const path=join(base,'outputs',fixture.accountId,job.id,'output.mp4');const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path],{encoding:'utf8'}));if(!probe.streams.some(s=>s.codec_name==='hevc')||!probe.streams.some(s=>s.codec_name==='aac')||Math.abs(Number(probe.format.duration)-fixture.expectedSeconds)>.1)throw Error('Unexpected media output');outputs.push({jobId:job.id,path,probe});}
 for(let i=0;i<45&&worker.exitCode===null;i++)await sleep(1000);
 if(worker.exitCode!==0)throw Error('Renderer did not shut down after idle');
 const evidence={origin,passed:true,noQueueWindowOpened:true,workerExitedIdle:worker.exitCode===0,release:release.id,outputs};
 await writeFile('analysis/render-queue-recovery-2026-10-28/background-fixture.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS: two complete HEVC/AAC exports without a queue window; idle worker exit',worker.exitCode);
}finally{if(worker?.exitCode===null)worker.kill('SIGTERM');server.kill('SIGTERM');}
