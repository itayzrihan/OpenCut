// Reopen the real saved outputs in the canonical runtime. Never changes the live project.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {CanonicalClassicSession} from '../../classic/apps/web/src/core/canonical-classic-session';
import {createCanonicalTestRuntime} from '../../classic/apps/web/src/core/__tests__/canonical-runtime-fixture';
const folder='.local/seven-smart-2026-10-20';
const report='analysis/seven-smart-2026-10-20';
const projectFolder='/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/9deb36b6-ef21-47bd-a830-9ad0ea784759';
const baseline=JSON.parse(await readFile(`${folder}/project-before-extract.json`,'utf8'));
const earliest=JSON.parse(await readFile(`${folder}/project-before.json`,'utf8'));
const current=JSON.parse(await readFile(`${projectFolder}/project.json`,'utf8'));
const mediaAssets=JSON.parse(await readFile(`${projectFolder}/media/index.json`,'utf8')).map(({file,url,thumbnailUrl,buffer,...m}:any)=>m);
const sourceIds=new Set(baseline.scenes.map((s:any)=>s.id));
const outputs=current.scenes.filter((s:any)=>!sourceIds.has(s.id));
assert.equal(outputs.length,7);
for(const scene of baseline.scenes)assert.deepEqual(current.scenes.find((s:any)=>s.id===scene.id),scene);
assert.deepEqual(current.settings,baseline.settings);assert.deepEqual(current.transcriptionJobs,baseline.transcriptionJobs);
for(const scene of earliest.scenes){
 const after=current.scenes.find((s:any)=>s.id===scene.id);
 assert.deepEqual(after.tracks.main,scene.tracks.main);assert.deepEqual(after.tracks.audio,scene.tracks.audio);
 for(const track of scene.tracks.overlay)assert.deepEqual(after.tracks.overlay.find((t:any)=>t.id===track.id),track);
}
const seen=new Set<number>();const results=[];
for(const scene of outputs){
 assert.equal(scene.podcastExtract.sourceSceneId,'multicam-scene-1');assert.equal(scene.podcastExtract.options.mode,'highlights');
 const archive=scene.takeAssembly;assert.equal(archive.version,3);assert(archive.referenceRegions.length>0);
 const tracks=[scene.tracks.main,...scene.tracks.overlay,...scene.tracks.audio];
 const duration=Math.max(...tracks.flatMap((t:any)=>t.elements.map((e:any)=>e.startTime+e.duration)))/120000;
 assert(duration>=20&&duration<=90);
 const cameraCuts=scene.tracks.overlay.filter((t:any)=>t.type==='video').flatMap((t:any)=>t.elements);
 assert(cameraCuts.length&&cameraCuts.some((e:any)=>e.enabled!==false));
 const audio=scene.tracks.audio.filter((t:any)=>t.muted!==true).flatMap((t:any)=>t.elements).filter((e:any)=>e.enabled!==false&&e.muted!==true&&e.params?.muted!==true);
 assert(audio.length>0);
 const chosen=archive.plan.groups.flatMap((g:any)=>g.alternatives[g.selected].parts);
 const words=[];
 for(const part of chosen){for(let i=part.firstWord;i<=part.lastWord;i++){
  const w=archive.sourceWords[i];assert(w);assert(!seen.has(w.sourceIndex),'Repeated source words across outputs');seen.add(w.sourceIndex);words.push(w);
 }}
 const captions=scene.tracks.overlay.find((t:any)=>t.captionSource)?.captionSource.words??[];assert(captions.length>0);
 for(const t of scene.tracks.overlay.filter((t:any)=>t.type==='video')){
  const originals=archive.sourceTracks.overlay.find((s:any)=>s.id===t.id)?.elements;assert(originals);
  for(const e of t.elements){assert(originals.some((s:any)=>s.mediaId===e.mediaId&&(s.enabled!==false)===(e.enabled!==false)&&e.trimStart>=s.trimStart&&e.trimStart+Math.round(e.duration*(e.retime?.rate??1))<=s.trimStart+Math.round(s.duration*(s.retime?.rate??1))+1));}
 }
 results.push({sceneId:scene.id,title:scene.name,durationSeconds:Number(duration.toFixed(3)),cameraCuts:cameraCuts.length,audioClips:audio.length,captionWords:captions.length,parts:chosen.length,unverifiedBoundaries:archive.quality?.unverifiedBoundaries??0,sourceSpans:chosen.map((p:any)=>({startSeconds:archive.sourceWords[p.firstWord].start/120000,endSeconds:archive.sourceWords[p.lastWord].end/120000})),dialogue:words.map((w:any)=>w.text).join(' ')});
}
const runtime=await createCanonicalTestRuntime();try{
 delete current.__opencutEditorSession;
 const session=new CanonicalClassicSession({runtime,projectId:current.metadata.id});session.attach({classic:{document:current,mediaAssets}});
 assert.deepEqual(session.read().document.scenes,current.scenes);
}finally{runtime.free();}
await mkdir(report,{recursive:true});
await writeFile(`${folder}/output-review.json`,JSON.stringify(results,null,2));
const evidence={passed:true,projectId:current.metadata.id,sourceSceneId:'multicam-scene-1',originalSceneCount:baseline.scenes.length,outputCount:7,sourceScenesExact:true,sourceMediaBeforeTranscriptionExact:true,settingsExact:true,transcriptionExact:true,noRepeatedSourceWords:true,canonicalReload:true,outputs:results.map(({dialogue,...r})=>r)};
await writeFile(`${report}/outputs.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
