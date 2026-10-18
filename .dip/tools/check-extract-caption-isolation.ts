// Isolated browser regression, never connects to the user's editor or account.
import {acquireBrowser,releaseBrowser} from '../../classic/apps/web/node_modules/@hyperframes/engine/dist/index.js';
const root=new URL('../../classic/rust/editor-runtime-wasm/pkg/',import.meta.url);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
 const p=new URL(req.url).pathname;
 if(p==='/fixture')return new Response(Bun.file(new URL('../../crates/editor-api/tests/fixtures/classic-project.json',import.meta.url)));
 if(p.endsWith('.js'))return new Response(Bun.file(new URL('opencut_editor_runtime_wasm_bg.js',root)),{headers:{'Content-Type':'text/javascript'}});
 if(p.endsWith('.wasm'))return new Response(Bun.file(new URL('opencut_editor_runtime_wasm_bg.wasm',root)),{headers:{'Content-Type':'application/wasm'}});
 return new Response('<title>Isolated extraction caption regression</title>',{headers:{'Content-Type':'text/html'}});
}});
const lease=await acquireBrowser([],{enableBrowserPool:false,forceScreenshot:true});
try{
 const page=await lease.browser.newPage();page.setDefaultTimeout(60000);await page.goto(`http://127.0.0.1:${server.port}`);
 const result=await page.evaluate(async()=>{
  const g=await import('/runtime.js');const {instance}=await WebAssembly.instantiate(await(await fetch('/runtime.wasm')).arrayBuffer(),{'./opencut_editor_runtime_wasm_bg.js':g});g.__wbg_set_wasm(instance.exports);instance.exports.__wbindgen_start();
  const runtime=new g.CanonicalEditorRuntime();const call=(id,input)=>runtime.invokeSync(id,input,{}).result.data;
  const classic=await(await fetch('/fixture')).json();const scene=classic.document.scenes[0];
  scene.tracks.main.elements[0].duration=650*120000;scene.tracks.main.elements[0].retime={rate:1};
  scene.tracks.overlay[0].captionSource.words=Array.from({length:210},(_,i)=>({text:`word${i}`,start:i*3+.1,end:i*3+1.5}));
  scene.tracks.overlay[0].elements=Array.from({length:210},(_,i)=>({id:`cue-${i}`,type:'text',name:'Caption',startTime:i*3*120000,duration:180000,trimStart:0,trimEnd:0,params:{content:`word${i}`,fontFamily:'Arial'},wordRuns:[{id:`run-${i}`,text:`word${i}`,startTime:24000,endTime:156000}]}));
  call('project.classic.session.attach',{projectId:'classic-project',expectedRevision:0,classic});
  const initial=runtime.snapshot();const main=JSON.stringify(initial.project.classic.document.scenes[0]);let previous=initial.project.classic.document.scenes;
  for(const mode of ['teaser','highlights','chronological','teaser','highlights','chronological']){
   call('timeline.classic.podcast.extract',{projectId:'classic-project',sceneId:'main-scene',expectedRevision:runtime.snapshot().revision,elementIds:['item-2'],options:{mode,minSeconds:20,maxSeconds:90,maxOutputs:1},videos:[{title:`Output ${mode}`,openingHook:'Opening',endingHook:'Ending',confidence:.9,alternatives:[{label:'Complete',reason:'Complete passage',parts:[{firstWord:10,lastWord:20}]}]}]});
   let current=runtime.snapshot();let scenes=current.project.classic.document.scenes;
   if(JSON.stringify(scenes.slice(0,previous.length))!==JSON.stringify(previous))throw Error('Generation changed an earlier scene');
   const output=scenes.at(-1);const track=output.tracks.overlay.find(t=>t.type==='text'&&t.elements.length);if(!track)throw Error('Missing generated caption');const cue=track.elements[0];
   call('timeline.classic.elements.update',{projectId:'classic-project',sceneId:output.id,expectedRevision:current.revision,updates:[{trackId:track.id,elementId:cue.id,patch:{params:{content:'Edited output only'}}}]});
   scenes=runtime.snapshot().project.classic.document.scenes;
   if(JSON.stringify(scenes[0])!==main||JSON.stringify(scenes.slice(0,previous.length))!==JSON.stringify(previous))throw Error('Editing output caption changed another scene');
   if(!scenes.at(-1).tracks.overlay.some(t=>t.elements.some(e=>e.params?.content==='Edited output only')))throw Error('Output caption edit missing');
   previous=scenes;
  }
  runtime.free();return {runs:6,modes:['teaser','highlights','chronological'],outputCaptionEdits:6,sourceExact:true,previousOutputsExact:true};
 });console.log('PASS',JSON.stringify(result));
}finally{await releaseBrowser(lease.browser,{enableBrowserPool:false});server.stop(true);}
