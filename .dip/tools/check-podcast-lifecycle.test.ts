// Isolated host lifecycle regression with the real task, no live editor/provider.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- editor doubles. */
import {afterEach,expect,mock,test} from 'bun:test';
import type {EditorCore} from '../../classic/apps/web/src/core';
import {getPodcastTask} from '../../classic/apps/web/src/ai/podcast-task';
import {podcastPlanCacheKey} from '../../classic/apps/web/src/ai/podcast-plan-cache';
const original={fetch:globalThis.fetch,window:globalThis.window,storage:globalThis.localStorage};
afterEach(()=>{globalThis.fetch=original.fetch;globalThis.window=original.window;globalThis.localStorage=original.storage;});
for(const mode of ['highlights','chronological'] as const){
 test(`${mode} ignores legacy final proposal, saves new scenes and consumes only draft artifacts`,async()=>{
 const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
 globalThis.localStorage=storage as Storage;globalThis.window=Object.assign(new EventTarget(),{__opencutAccountId:'account'}) as any;
 globalThis.fetch=mock(async()=>Response.json({models:[{id:'test'}]})) as any;
 const words=Array.from({length:10},(_,id)=>({id,sourceIndex:id,clipId:'clip',text:`word${id}`,start:id*360000,end:id*360000+120000}));
 const options={mode,minSeconds:20,maxSeconds:90,maxOutputs:3};
 const key=await podcastPlanCacheKey({account:'account',projectId:'project',sceneId:'source',options,words,sourceFingerprint:'same-source'});
 const video={title:'Specific complete insight',openingHook:'Actual words',endingHook:'Complete conclusion',confidence:.9,alternatives:[{label:'Reviewed',reason:'Specific example',parts:[{firstWord:0,lastWord:9}]}]};
 storage.setItem(key,JSON.stringify({videos:[{...video,title:'Unreviewed stale final'}]}));
 storage.setItem(`${key}:editorial-v1`,JSON.stringify({version:1,responses:{'inventory:0:0':{summary:'source map'},'draft:0':{specific:true},'critique:0:0':{accepted:true}}}));
 const apply=mock(()=>{}),save=mock(async()=>{}),editorial=mock(()=>({policyVersion:'podcast-shorts-v2',complete:true,requests:[],videos:[video],report:{}}));
 const scene={id:'source',tracks:{main:{elements:[{id:'clip',type:'video'}]},overlay:[{type:'text',captionSource:{}}]}};
 const editor={project:{getActive:()=>({metadata:{id:'project'}}),getActiveOrNull:()=>({metadata:{id:'project'}}),getSessionReadOnlyReason:()=>null},scenes:{getActiveScene:()=>scene,getActiveSceneOrNull:()=>scene},selection:{getSelectedElements:()=>[]},command:{podcastScope:()=>({revision:1,referenceRegions:[],hasTranscript:true}),getCanonicalRevision:()=>1,planEditingProviderRetry:()=>({retry:false,delayMs:0,maxAttempts:1}),preparePodcast:()=>({revision:1,sourceFingerprint:'same-source',words,windows:[],editorial,review:()=>{},analyzeAudio:async()=>[],apply}),undo:()=>{},flushHistory:async()=>{}},save:{flush:save},playback:{pause:()=>{},seek:()=>{}}} as unknown as EditorCore;
 const task=getPodcastTask(editor);await task.start(options);
 expect(task.getSnapshot().status).toBe('succeeded');expect(editorial).toHaveBeenCalledTimes(1);expect(apply).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);
 expect(apply.mock.calls[0]?.[0]?.videos[0].title).toBe(video.title);
 const journal=JSON.parse(storage.getItem(`${key}:editorial-v1`)!);expect(Object.keys(journal.responses)).toEqual(['inventory:0:0']);expect(storage.getItem(key)).toBeNull();
 });
}
