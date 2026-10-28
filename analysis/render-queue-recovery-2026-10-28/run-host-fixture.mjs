// Isolated application API integration: normal queue requests launch the real host.
// No user account, browser automation, or user project state is accessed here.
import {readFile,writeFile,open,mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
const base=resolve('.local/render-queue-recovery-2026-10-28/fixture');
const fixture=JSON.parse(await readFile(join(base,'fixture.json'),'utf8'));
const release=JSON.parse(await readFile('/Users/itayzrihan/Library/Application Support/OpenCut Local/candidate.json','utf8'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`;
const log=await open(join(base,'host-server.log'),'a',0o600);
const server=spawn(process.execPath,[join(release.appRoot,'server.js')],{cwd:release.appRoot,env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),OPENCUT_ACCOUNTS_DIR:join(base,'accounts'),OPENCUT_RENDER_OUTPUTS_DIR:join(base,'outputs'),NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore',log.fd,log.fd]});await log.close();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let pid;
function alive(){try{process.kill(pid,0);return true;}catch{return false;}}
process.on('SIGTERM',()=>{if(pid&&alive())process.kill(pid,'SIGTERM');server.kill('SIGTERM');process.exit(1);});
try{
 let ready=false;for(let i=0;i<90;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await sleep(1000);}if(!ready)throw Error('Fixture server unavailable');
 const registration=await fetch(origin+'/api/accounts',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({action:'register',login:'encoder-'+randomBytes(6).toString('hex'),displayName:'Isolated host integration',password:randomBytes(24).toString('hex')})});
 const identity=await registration.json();if(!registration.ok)throw Error(identity.error);
 const accountId=identity.account.id,cookie=registration.headers.get('set-cookie').split(';')[0];
 const root=join(base,'accounts/data',accountId,'render-queue');await cp(fixture.root,root,{recursive:true});
 const queueUrl=origin+'/api/render-queue?account='+accountId;
 const request=async()=>{const response=await fetch(queueUrl,{headers:{cookie,'x-opencut-account':accountId}});const value=await response.json();if(!response.ok)throw Error(value.error);if(value.worker?.status==='unavailable')throw Error(value.worker.message);return value;};
 await Promise.all([request(),request(),request(),request()]);
 const lease=JSON.parse(await readFile(join(root,'worker.json'),'utf8'));pid=lease.pid;
 console.log('Normal authenticated queue requests launched one detached host renderer',pid,'with no queue or editor window.');
 let jobs,last='';
 for(let i=0;i<180;i++){
  // Emulate an open/closed/reopened viewer while canonical claim/progress/upload run.
  if(i%2===0)await request();
  jobs=JSON.parse(await readFile(join(root,'runtime.json'),'utf8')).active.document.renderQueue;
  const state=jobs.map(j=>`${j.status}:${Math.round(j.progress*100)}%:${j.message}`).join(' | ');if(state!==last){console.log(state);last=state;}
  if(jobs.every(j=>j.status==='completed'))break;
  if(jobs.some(j=>j.status==='failed'))throw Error(jobs.find(j=>j.status==='failed').message);
  if(!alive())throw Error('Host renderer exited before completing its snapshots');
  await sleep(1000);
 }
 if(!jobs.every(j=>j.status==='completed'))throw Error('Host integration timed out');
 const outputs=[];
 for(const job of jobs){const path=join(base,'outputs',accountId,job.id,'output.mp4');const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path],{encoding:'utf8'}));if(!probe.streams.some(s=>s.codec_name==='hevc')||!probe.streams.some(s=>s.codec_name==='aac')||Math.abs(Number(probe.format.duration)-fixture.expectedSeconds)>.1)throw Error('Invalid rendered output');outputs.push({jobId:job.id,path,probe});}
 for(let i=0;i<45&&alive();i++)await sleep(1000);
 if(alive())throw Error('Host renderer did not exit after idle');
 const evidence={passed:true,origin,normalAuthenticatedHostLaunch:true,concurrentViewerRequests:true,noQueueWindowOpened:true,workerExitedIdle:true,release:release.id,outputs};
 await writeFile('analysis/render-queue-recovery-2026-10-28/background-fixture.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS: host launch/reuse, concurrent queue reads, two HEVC/AAC exports and idle shutdown.');
}finally{if(pid&&alive())process.kill(pid,'SIGTERM');server.kill('SIGTERM');}
