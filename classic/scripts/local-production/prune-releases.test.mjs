import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneReleases} from './prune-releases.mjs';
test('retains active, rollback, candidate and newest releases; ignores unknown data and symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opencut-retention-'));
 try {
  const releases=join(root,'releases');await mkdir(releases);
  const ids=Array.from({length:10},(_,i)=>`2026-10-20T10-00-0${i}-000Z-12345678`);
  for(const id of ids){await mkdir(join(releases,id));await writeFile(join(releases,id,'release.json'),JSON.stringify({id}));}
  for(const [name,index] of [['current',2],['previous',1],['candidate',8]])await writeFile(join(root,`${name}.json`),JSON.stringify({id:ids[index]}));
  await mkdir(join(releases,'unknown'));await writeFile(join(releases,'unknown','original.txt'),'keep');
  await mkdir(join(root,'account-media'));await writeFile(join(root,'account-media','original.txt'),'keep');
  await symlink(join(root,'account-media'),join(releases,'2026-10-19T00-00-00-000Z-12345678'));
  const dry=await pruneReleases({deploymentRoot:root,dryRun:true});assert.equal(dry.removed.length,5);assert.equal((await readdir(releases)).length,12);
  const result=await pruneReleases({deploymentRoot:root});
  assert.deepEqual(new Set(result.retained),new Set([ids[1],ids[2],ids[7],ids[8],ids[9]]));
  assert.equal(await readFile(join(root,'account-media','original.txt'),'utf8'),'keep');
  assert.equal(await readFile(join(releases,'unknown','original.txt'),'utf8'),'keep');
  assert.equal((await readdir(releases)).length,7);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('invalid retention policy fails before filesystem changes',async()=>{
 await assert.rejects(pruneReleases({deploymentRoot:'/unused',keepRecent:0}),/at least one/);
});
