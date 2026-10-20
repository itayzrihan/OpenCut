// Canonical browser adapter/WASM regression on a saved edited-project copy.
// Synthetic transcript supplies known word clocks only; no model/audio claims.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {CanonicalClassicSession} from '../../classic/apps/web/src/core/canonical-classic-session';
import {createCanonicalTestRuntime} from '../../classic/apps/web/src/core/__tests__/canonical-runtime-fixture';
const folder='.local/podcast-multicam-scope';
const reportFolder='analysis/podcast-multicam-scope-2026-10-19';
await mkdir(reportFolder,{recursive:true});
const document=JSON.parse(await readFile(`${folder}/live-project-before.json`,'utf8'));delete document.__opencutEditorSession;
const mediaAssets=JSON.parse(await readFile(`${folder}/live-media-index.json`,'utf8')).map(({file,url,thumbnailUrl,buffer,...m}:any)=>m);
const actual=document.scenes.find((s:any)=>s.id==='multicam-scene-1');assert(actual);assert.equal(actual.tracks.main.elements.length,0);
const cuts=actual.tracks.overlay.filter((t:any)=>t.type==='video').flatMap((t:any)=>t.elements);
const allMedia=[...cuts,...actual.tracks.audio.flatMap((t:any)=>t.elements)];
const end=Math.max(...allMedia.map((e:any)=>e.startTime+e.duration));
actual.tracks.overlay.push({id:'scoped-fixture-transcript',type:'text',name:'Isolated synthetic word-clock fixture',hidden:false,elements:[],captionSource:{sourceId:'scope-fixture',settings:{wordsPerRow:3,rows:1},words:Array.from({length:Math.floor(end/60000)},(_,i)=>({text:`scope-word-${i}`,start:i*.5,end:i*.5+.35}))}});
const active=cuts.filter((e:any)=>e.enabled!==false).sort((a:any,b:any)=>a.startTime-b.startTime);
function group(after:number){const ids:string[]=[];let seconds=0;for(const e of active){if(e.startTime<after)continue;ids.push(e.id);seconds+=e.duration/120000;if(seconds>=50)break;}assert(seconds>=30);return ids;}
const selected=[...group(0),...group(Math.floor(end/2))];
const rt=await createCanonicalTestRuntime();const session=new CanonicalClassicSession({runtime:rt,projectId:document.metadata.id});
session.attach({classic:{document,mediaAssets}});const before=structuredClone(session.read());
const results:any[]=[];const timings:any[]=[];
function contains(regions:any[],a:number,b:number){return regions.some(r=>a>=r.start&&b<=r.end);}
try{
 for(const selection of ['whole','selected'] as const){
  const elementIds=selection==='whole'?[]:selected;
  const start=performance.now();const scope=session.podcastScope({sceneId:actual.id,elementIds});const scopeMs=performance.now()-start;
  const prepStart=performance.now();const source=session.preparePodcast({sceneId:actual.id,elementIds});const prepareMs=performance.now()-prepStart;
  assert.equal(scope.hasTranscript,true);assert(source.words.length>100);assert(source.referenceRegions!.length>=1);
  if(selection==='selected'){assert(source.referenceRegions!.length>=2);assert(source.words.length<actual.tracks.overlay.at(-1).captionSource.words.length);}
  const regions=source.referenceRegions!;
  assert(source.words.every(w=>contains(regions,w.start,w.end)));
  assert(source.audioInputs!.every(i=>contains(regions,i.clip.startTime,i.clip.startTime+i.clip.duration)));
  const byRegion=new Map<string,number[]>();for(const w of source.words){const a=byRegion.get(w.clipId)??[];a.push(w.id);byRegion.set(w.clipId,a);}
  const first=[...byRegion.values()][0],last=[...byRegion.values()].at(-1)!;
  assert(first.length>42&&last.length>20);
  const parts=[{firstWord:first[0],lastWord:first[15]},{firstWord:first[22],lastWord:first[37]},{firstWord:byRegion.size>1?last[0]:first[44],lastWord:byRegion.size>1?last[15]:first[59]}];
  const video={title:`Scoped ${selection}`,openingHook:'Known test words',endingHook:'Complete fixture range',confidence:.9,alternatives:[{label:'Scope regression',reason:'Tests timeline mapping only',parts}]};
  for(const mode of ['teaser','highlights','chronological'] as const){
   const modeVideo=mode==='chronological'?{...video,alternatives:[{...video.alternatives[0],parts:[{firstWord:first[0],lastWord:first[15]},{firstWord:first[22],lastWord:first[37]},{firstWord:first[44],lastWord:first[59]}]}]}:video;
   const bound={sceneId:actual.id,elementIds,expectedRevision:session.status().revision};const options={mode,minSeconds:20,maxSeconds:90,maxOutputs:1};
   const stage=session.podcastEditorial({...bound,options,responses:{}});
   assert(stage.requests.length>0&&stage.requests.every(r=>r.stage==='inventory'));
   for(const r of stage.requests){const words=(r.prompt as any).words;assert(words.every((w:any)=>contains(regions,w.start,w.end)));}
   session.podcast({...bound,options,videos:[modeVideo],review:true});session.podcast({...bound,options,videos:[modeVideo]});
   const current=session.read(),out=current.document.scenes.at(-1)!;
   assert.deepEqual(current.document.scenes.slice(0,before.document.scenes.length),before.document.scenes);
   assert.deepEqual(current.document.settings,before.document.settings);
   assert.deepEqual(current.document.transcriptionJobs,before.document.transcriptionJobs);
   assert(out.tracks.main.elements.length===0);
   const outputCuts=out.tracks.overlay.filter((t:any)=>t.type==='video').flatMap((t:any)=>t.elements);
   assert(outputCuts.length>0);assert(out.tracks.audio.some((t:any)=>t.elements.length));
   assert((out as any).takeAssembly.referenceRegions.every((r:any)=>contains(regions,r.start,r.end)));
   const captions=out.tracks.overlay.find((t:any)=>t.captionSource)?.captionSource?.words??[];assert(captions.length>0);
   assert(captions.every((w:any)=>{const i=Number(w.text.split('-').at(-1));return contains(regions,i*60000,i*60000+42000);}));
   const archive=(out as any).takeAssembly.sourceTracks;
   for(const track of out.tracks.overlay.filter((t:any)=>t.type==='video')){
    const originals=archive.overlay.find((t:any)=>t.id===track.id).elements;
    for(const clip of track.elements){assert(originals.some((s:any)=>{const rate=s.retime?.rate??1;return s.mediaId===clip.mediaId&&(s.enabled!==false)===(clip.enabled!==false)&&clip.trimStart>=s.trimStart&&clip.trimStart+Math.round(clip.duration*rate)<=s.trimStart+Math.round(s.duration*rate)+1;}));}
   }
   results.push({selection,mode,referenceRegions:regions.length,words:source.words.length,outputCameraCuts:outputCuts.length,outputCaptionWords:captions.length,sourceExact:true,audioRetained:true,noExcludedWords:true,noExcludedDecodeRanges:true});
  }
  timings.push({selection,scopeMs,prepareMs});
 }
 const reopened=await createCanonicalTestRuntime();const restored=new CanonicalClassicSession({runtime:reopened,projectId:document.metadata.id});restored.attach({classic:session.read()});assert.deepEqual(restored.read().document.scenes,session.read().document.scenes);reopened.free();
 // Many adjacent camera cuts remain one reference interval and transcript clock.
 const fixture=JSON.parse(await readFile('crates/editor-api/tests/fixtures/classic-project.json','utf8'));const s=fixture.document.scenes[0];const original=s.tracks.main.elements[0];s.tracks.main.elements=[];
 const n=5000;
 s.tracks.overlay=[0,1].map(camera=>({id:`stress-camera-${camera}`,type:'video',name:'Camera',muted:true,hidden:false,elements:Array.from({length:n},(_,i)=>({...original,id:`stress-${camera}-${i}`,startTime:i*60000,duration:60000,trimStart:i*60000,trimEnd:0,retime:{rate:1},enabled:i%2===camera,params:{volume:0}}))}));
 s.tracks.overlay.push({id:'stress-words',type:'text',name:'Transcript',hidden:false,elements:[],captionSource:{sourceId:'stress',words:Array.from({length:n*2},(_,i)=>({text:`w${i}`,start:i*.25,end:i*.25+.2})),settings:{}}});
 const stressRt=await createCanonicalTestRuntime();const stress=new CanonicalClassicSession({runtime:stressRt,projectId:'classic-project'});stress.attach({classic:fixture});
 const ids=s.tracks.overlay.filter((t:any)=>t.type==='video').flatMap((t:any)=>t.elements.map((e:any)=>e.id));
 const start=performance.now();const scope=stress.podcastScope({sceneId:'main-scene',elementIds:ids});const scopeMs=performance.now()-start;
 const prepStart=performance.now();const prepared=stress.preparePodcast({sceneId:'main-scene',elementIds:ids});const prepareMs=performance.now()-prepStart;
 assert.equal(scope.referenceRegions.length,1);assert.equal(prepared.words.length,10000);assert(scopeMs<2000);assert(prepareMs<6000);stressRt.free();timings.push({selection:'10000-camera-cuts',scopeMs,prepareMs});
 await writeFile(`${folder}/metrics.json`,JSON.stringify(timings,null,2));
 const evidence={passed:true,realProjectId:document.metadata.id,originalScenes:before.document.scenes.length,originalCameraCuts:cuts.length,syntheticTranscript:true,actualInference:false,liveProjectWritten:false,results,archiveReloaded:true,stress:{cameraCuts:10000,words:10000,referenceRegions:1,scopeUnder2s:true,prepareUnder6s:true}};
 await writeFile(`${reportFolder}/source-verification.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{rt.free();}
