// Real-provider evaluation only when explicitly invoked; --replay never uses a provider.
// Isolated canonical WASM + real browser adapter. Never mutates a live project.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {writeFileSync,renameSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createCanonicalTestRuntime} from '../../classic/apps/web/src/core/__tests__/canonical-runtime-fixture';
import {CanonicalClassicSession} from '../../classic/apps/web/src/core/canonical-classic-session';
import {requestPodcastPlan} from '../../classic/apps/web/src/ai/podcast-plan';
import {podcastPlanCacheKey} from '../../classic/apps/web/src/ai/podcast-plan-cache';
const replay=process.argv.includes('--replay');
const root='.local/podcast-editorial-upgrade',reportRoot='analysis/podcast-editorial-upgrade-2026-10-19';
await mkdir(root,{recursive:true});await mkdir(reportRoot,{recursive:true});
const checkpointPath=`${root}/provider-checkpoints.json`;
let data:Record<string,string>={};try{data=JSON.parse(await readFile(checkpointPath,'utf8'));}catch{}
function persist(){writeFileSync(`${checkpointPath}.tmp`,JSON.stringify(data));renameSync(`${checkpointPath}.tmp`,checkpointPath);}
const storage={getItem:(k:string)=>data[k]??null,setItem:(k:string,v:string)=>{data[k]=v;persist();},removeItem:(k:string)=>{delete data[k];persist();}};
const account={id:'4fec0688-9a78-4304-849c-9ea937873751',displayName:'',login:''};
const originalFetch=globalThis.fetch;let calls=0;let models:any[]=[];
const modelsSeen=new Set<string>();
const provider=replay?null:await import('../../classic/apps/web/src/editor-agent/server/chatgpt');
const accountServer=replay?null:await import('../../classic/apps/web/src/accounts/server');
globalThis.window=Object.assign(new EventTarget(),{__opencutAccountId:account.id}) as any;
globalThis.fetch=(async(input:any,init:any)=>{
 if(String(input)==='/api/editor-agent/connection')return Response.json({models:replay?[{id:'checkpoint-replay'}]:models.length?models:models=await provider!.chatGPTModels(init.signal)});
 if(String(input)==='/api/editor-agent/respond'){
  if(replay)throw Error('Replay unexpectedly requested fresh inference');
  const request=JSON.parse(init.body);calls++;modelsSeen.add(request.model);console.log('provider request',calls,request.model);
  return provider!.streamChatGPTResponse({body:{...request,reasoning:{effort:'high',summary:'auto'},include:['reasoning.encrypted_content'],parallel_tool_calls:false},signal:init.signal});
 }
 return originalFetch(input,init);
}) as any;
const results:any[]=[];
async function evaluate(){
 for(const mode of ['highlights','chronological'] as const){
  const runtime=await createCanonicalTestRuntime();
  try{
   const classic=JSON.parse(await readFile('.local/episode-teaser-90-2026-10-14/classic-source.json','utf8'));
   classic.mediaAssets=classic.mediaAssets.map(({file,url,thumbnailUrl,buffer,...m}:any)=>m);
   const session=new CanonicalClassicSession({runtime,projectId:classic.document.metadata.id});session.attach({classic});
   const before=session.read(),sceneId=classic.document.scenes[0].id,elementIds=['classic-clip-1'];
   const prepared=session.preparePodcast({sceneId,elementIds});
   const binding={sceneId,elementIds,expectedRevision:prepared.revision};
   const options={mode,minSeconds:20,maxSeconds:90,maxOutputs:3};
   const key=await podcastPlanCacheKey({account:account.id,projectId:classic.document.metadata.id,sceneId,words:prepared.words,sourceFingerprint:prepared.sourceFingerprint,options});
   // Same-source inventory reuse for this evaluation only. Editorial selection,
   // mode constraints and per-short critics still run independently in both modes.
   if(mode==='chronological'&&!data[`${key}:editorial-v1`]){
    const previous=Object.entries(data).find(([k])=>k.endsWith(':editorial-v1'));
    if(previous){const responses=Object.fromEntries(Object.entries(JSON.parse(previous[1]).responses).filter(([k])=>k.startsWith('inventory:')));storage.setItem(`${key}:editorial-v1`,JSON.stringify({version:1,responses}));}
   }
   const start=Date.now(),firstCall=calls;
   const videos=await requestPodcastPlan({source:{...prepared,editorial:input=>session.podcastEditorial({...binding,...input})},options,signal:AbortSignal.timeout(25*60*1000),onStage:stage=>console.log(mode,stage),review:input=>{session.podcast({...binding,...input,review:true});},cache:{key,storage}});
   assert.deepEqual(session.read(),before,'Planning mutated the editor');
   const report=JSON.parse(data[`${key}:editorial-v1:report`]);
   assert.equal(report.windowsReviewed,prepared.windows.length);assert(report.critiques.length===videos.length);
   session.podcast({...binding,options,videos,review:true});session.podcast({...binding,options,videos});
   const after=session.read();
   const document=after.document,old=before.document;
   assert.deepEqual(document.scenes.slice(0,old.scenes.length),old.scenes);
   assert.deepEqual(document.transcriptionJobs,old.transcriptionJobs);assert.deepEqual(document.settings,old.settings);
   const generated=document.scenes.slice(old.scenes.length);assert.equal(generated.length,videos.length);
   const sourceGain=old.scenes[0].tracks.main.elements[0].params.volume;
   const outputGains=generated.flatMap((s:any)=>s.tracks.main.elements.map((e:any)=>e.params.volume??0));
   assert.equal(sourceGain,0);assert(outputGains.every((v:number)=>v===sourceGain),'Authored dB gain changed in derived dialogue');
   const cuts=videos.map((v:any,i:number)=>({title:v.title,premise:report.shorts[i].premise,seconds:Math.max(...generated[i].tracks.main.elements.map((e:any)=>(e.startTime+e.duration)/120000)),parts:v.alternatives[0].parts.map((p:any)=>({...p,sourceIn:prepared.words[p.firstWord].start/120000,sourceOut:prepared.words[p.lastWord].end/120000,text:prepared.words.slice(p.firstWord,p.lastWord+1).map((w:any)=>w.text).join(' ')}))}));
   for(const c of cuts)assert(c.seconds>=20&&c.seconds<=90);
   const result={mode,options,videos,report,cuts,windows:prepared.windows.length,wordCount:prepared.words.length,sourceScenesExact:true,transcriptionExact:true,sourceAudioGain:sourceGain,outputAudioGains:outputGains,sourceAudioPreserved:true,sourceSceneCount:old.scenes.length,outputScenes:generated.length,providerCalls:calls-firstCall,elapsedMs:replay?0:Date.now()-start,models:modelsSeen.size?[...modelsSeen]:models.slice(0,1).map(m=>m.id),checkpointResponses:Object.keys(JSON.parse(data[`${key}:editorial-v1`]).responses).length,replay};
   if(!replay)await writeFile(`${root}/${mode}-real.json`,JSON.stringify(result,null,2));
   results.push(result);console.log(JSON.stringify({mode,complete:true,windows:result.windows,outputs:result.outputScenes,rounds:report.rounds,seconds:cuts.map((c:any)=>c.seconds),calls:result.providerCalls,sourceExact:true}));
  }finally{runtime.free();}
 }
}
try{if(replay)await evaluate();else await accountServer!.accountScope.run(account,evaluate);}
finally{persist();globalThis.fetch=originalFetch;}
await writeFile(`${reportRoot}/${replay?'replay':'real-provider'}.json`,JSON.stringify({passed:true,results},null,2));
