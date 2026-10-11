import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const argument = process.argv.find(a => a.startsWith('--root='));
const root = argument ? path.resolve(argument.slice(7)) : fileURLToPath(new URL('../../resources/hyperframes/',import.meta.url));
const read = async file => JSON.parse(await readFile(path.join(root,file),'utf8'));
const base=await read('catalog.json'), supplement=await read('catalog-supplement.json');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!/^[a-f0-9]{40}$/.test(supplement.upstreamCommit))throw new Error('Invalid upstream commit');
const registry=await readFile(path.join(root,`upstream/${supplement.upstreamCommit}/registry/registry.json`));
if(digest(registry)!==supplement.registrySha256)throw new Error('Official registry hash differs');
const ids=new Set(base.items.map(i=>i.id));let checked=0;
for(const item of supplement.items){
 if(ids.has(item.id))throw new Error('Supplement overwrites a reviewed entry');ids.add(item.id);
 const expected=`upstream/${supplement.upstreamCommit}/registry/${item.kind}s/${item.id}`;
 if(item.sourcePath!==expected)throw new Error('Invalid source provenance');
 for(const file of item.files){
  if(!file.path || file.path.split('/').some(p=>!p||p==='.'||p==='..') || /[\\:]/.test(file.path))throw new Error('Unsafe source path');
  const bytes=await readFile(path.join(root,item.sourcePath,file.path));
  if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw new Error(`Corrupt source: ${item.id}/${file.path}`);checked++;
 }
 const manifest=await read(`${item.sourcePath}/registry-item.json`);
 if(manifest.name!==item.id||manifest.type!==`hyperframes:${item.kind}`)throw new Error('Invalid source identity');
 if(item.prompt.status==='original'&&item.prompt.text!==manifest.sourcePrompt)throw new Error('Original prompt differs');
}
for(const ref of JSON.parse(registry).items)if(!ids.has(ref.name))throw new Error(`Missing official item: ${ref.name}`);
console.log(JSON.stringify({catalogItems:ids.size,additions:supplement.items.length,filesChecked:checked,officialCommit:supplement.upstreamCommit}));
