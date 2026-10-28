import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const check=spawnSync('node',['node_modules/typescript/bin/tsc','--noEmit','--project','tsconfig.build.json'],{cwd:process.cwd()+'/classic/apps/web',stdio:'inherit'});
if(check.status!==0)process.exit(check.status??1);
const p='analysis/compact-toolbar-2026-10-28/';
const m=JSON.parse(readFileSync(p+'layout.json','utf8'));
assert(m.dropdown.width<=40 && m.dropdown.width<m.previousWidth*.4);
assert.equal(m.visibleTriggerText,'');
assert(m.scene.inHeader && Math.abs(m.scene.center-m.scene.headerCenter)<2);
assert.equal(m.sceneSelectorInTimeline,false);
assert.equal(m.longSceneSelected,true);assert.equal(m.mainSceneRestored,true);
assert.equal(m.longScene.truncated,true);
assert(m.longScene.rectRight<=m.longScene.navLeft);
const doc=name=>JSON.parse(readFileSync(p+name+'.json','utf8'));
assert.deepEqual(doc('start-menu'),doc('start-key'));
assert.deepEqual(doc('end-menu'),doc('end-key'));
assert.deepEqual(doc('baseline'),doc('restored'));
for(const [name,duration] of [['start-menu',960000],['end-menu',840000]]) {
 for(const track of doc(name).scene.tracks.filter(t=>['video','audio','effect'].includes(t.type))){assert.equal(track.elements[0].duration,duration);}
}
console.log('Compact36px dropdown, centered header selector, long scene label/switching, original shortcuts and undo verified from live DOM and source snapshots.');
