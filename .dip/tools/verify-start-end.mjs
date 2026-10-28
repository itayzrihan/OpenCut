import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
for (const [cmd,args,cwd] of [
 ['cargo',['test','-p','opencut-editor-api','--test','classic_start_end','--test','classic_remove','--test','classic_split'],process.cwd()],
 ['node',['node_modules/typescript/bin/tsc','--noEmit','--project','tsconfig.build.json'],process.cwd()+'/classic/apps/web'],
 ['bun',['run','test','src/actions/keybindings/__tests__/persistence.test.ts','src/actions/keybindings/__tests__/start-end.test.ts'],process.cwd()+'/classic/apps/web'],
]) {
 const r=spawnSync(cmd,args,{cwd,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
}
const live=JSON.parse(readFileSync('analysis/start-end-2026-10-28/live-verification.json','utf8'));
for (const k of ['startButton','endButton','startShortcut','endShortcut','splitShortcut','textInputGuard','undo','redo','reopened']) {
 if(live[k]!==true)throw Error(`Missing live verification: ${k}`);
}
console.log('Start End: canonical crop, migration and live buttons/shortcuts/Undo verified.');

const read = name => JSON.parse(readFileSync(`analysis/start-end-2026-10-28/${name}.json`,'utf8'));
const base = read('baseline');
for (const name of ['undo-start','restored','text-input-guard','reopened']) assert.deepEqual(read(name),base,name);
assert.deepEqual(read('start-button'),read('start-shortcut'));
assert.deepEqual(read('start-button'),read('redo-start'));
assert.deepEqual(read('end-button'),read('end-shortcut'));
for(const [name,duration,startTrim,endTrim] of [['start-button',960000,480000,0],['end-button',840000,0,600000]]) {
 const doc=read(name);
 for(const type of ['video','audio','effect']) {
  const track=doc.scene.tracks.find(t=>t.type===type);
  assert.equal(track.elements.length,1);const e=track.elements[0];
  assert.equal(e.startTime,0);assert.equal(e.duration,duration);assert.equal(e.trimStart,startTrim);assert.equal(e.trimEnd,endTrim);
 }
 assert.equal(doc.scene.bookmarks.length,1);
}
const split=read('split-shortcut').scene.tracks.find(t=>t.area==='main').elements;
assert.equal(split.length,2);assert.equal(split[0].duration,480000);assert.equal(split[1].startTime,480000);assert.equal(split[1].duration,960000);
console.log('Independent live snapshots confirm all-track crop, source offsets, equivalent buttons/keys, exact Undo/Redo and saved reopen.');
