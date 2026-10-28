/** Isolated test account only: exercise the real registry and production renderer. */
import {readFile,writeFile,mkdir,copyFile,stat} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createCanonicalTestRuntime} from "../../classic/apps/web/src/core/__tests__/canonical-runtime-fixture";
const base=resolve('.local/render-queue-recovery-2026-10-28/fixture');
const accountId='11111111-2222-4333-8444-555555555555';
const sourceRoot='/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/render-queue';
const original=JSON.parse(await readFile(join(sourceRoot,'runtime.json'),'utf8')).active.document.renderQueue.find((j:any)=>j.id==='aab31a8f-02d9-47ab-bc32-693e6c7cbe1b');
const snapshot=structuredClone(original.snapshot);
snapshot.document.metadata.name='Background encoder isolation fixture';
const root=join(base,'accounts/data',accountId,'render-queue');
const inputs=join(base,'inputs');await mkdir(inputs,{recursive:true});await mkdir(root,{recursive:true});await mkdir(join(base,'outputs'),{recursive:true});
const sources=JSON.parse(await readFile(join(sourceRoot,original.id,'sources.json'),'utf8'));
for(const s of sources){const target=join(inputs,s.id);await copyFile(s.path,target);s.path=target;const info=await stat(target);s.size=info.size;s.mtimeMs=info.mtimeMs;const asset=snapshot.mediaAssets.find((a:any)=>a.id===s.id);if(asset)asset.sourcePath=target;}
const runtime=await createCanonicalTestRuntime();
const ids=['aaaaaaaa-1111-4111-8111-111111111111','bbbbbbbb-2222-4222-8222-222222222222'];
for(const id of ids){
 runtime.invokeSync('render.queue.edit',{id,projectId:snapshot.document.metadata.id,expectedRevision:(runtime.snapshot() as any).revision,nowMs:Date.now(),change:{type:'enqueue',snapshot,sceneId:original.sceneId,sourceRevision:0,options:{...original.options,format:'mp4',includeAudio:true,quality:'very_high',preferences:{resolution:'source',encoding:'compact'}},delivery:'queue',destinationName:null}},{});
 await mkdir(join(root,id),{recursive:true});await writeFile(join(root,id,'sources.json'),JSON.stringify(sources));
}
await writeFile(join(root,'runtime.json'),runtime.serialize());runtime.free();
await writeFile(join(base,'fixture.json'),JSON.stringify({accountId,ids,root,base,expectedSeconds:12},null,2));
console.log('Seeded two frozen HEVC/audio jobs in an isolated account; no user projects modified.');
