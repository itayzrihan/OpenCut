import {expect,test} from 'bun:test';
import {podcastPlanCacheKey,readPodcastPlan,savePodcastPlan} from './podcast-plan-cache';
test('resume proposals are scoped to account, project, source words and options; corrupt data is not reused',async()=>{
 const input={account:'a',projectId:'p',sceneId:'s',options:{mode:'highlights' as const,minSeconds:20,maxSeconds:90,maxOutputs:7},words:[]};
 const key=await podcastPlanCacheKey(input);
 expect(await podcastPlanCacheKey({...input,account:'b'})).not.toBe(key);
 expect(await podcastPlanCacheKey({...input,projectId:'other'})).not.toBe(key);
 expect(await podcastPlanCacheKey({...input,options:{...input.options,maxOutputs:1}})).not.toBe(key);
 expect(await podcastPlanCacheKey({...input,sourceFingerprint:'changed-source-media-or-captions'})).not.toBe(key);
 expect(await podcastPlanCacheKey({...input,options:{...input.options,mode:'teaser'}})).toStartWith('opencut-strategic-teaser-v1:');
 const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)}};
 const videos=[{title:'Test',openingHook:'Opening',endingHook:'End',confidence:.9,alternatives:[{label:'First',reason:'Complete',parts:[{firstWord:0,lastWord:15}]}]}];
 savePodcastPlan(storage,key,videos);expect(readPodcastPlan(storage,key)).toEqual(videos);
 expect(readPodcastPlan(storage,'other')).toBeNull();data.set(key,'invalid');expect(readPodcastPlan(storage,key)).toBeNull();
});
