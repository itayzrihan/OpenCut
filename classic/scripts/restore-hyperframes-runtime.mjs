// Restore reproducible dist/ files omitted by the repository-wide ignore rule.
// The checked-in evidence and catalog hashes, not the network, are authoritative.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../resources/hyperframes/',import.meta.url));
const catalog=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8'));
const vendor=JSON.parse(await readFile(path.join(root,'vendor/manifest.json'),'utf8'));
const hashes=new Map();
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const within=(base,relative)=>{const target=path.resolve(base,relative);if(!target.startsWith(path.resolve(base)+path.sep))throw Error('Unsafe reference path');return target;};
let restored=0;
async function ensure(target,bytes,expected){if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw Error(`Invalid reference evidence: ${target}`);const existing=await readFile(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(existing){if(sha(existing)!==expected.sha256)throw Error(`Changed reference asset: ${target}`);return;}await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});restored++;}
for(const item of catalog.items){if(!item.prepared)continue;const base=within(root,item.prepared.sourcePath);const sourceBytes=await readFile(path.join(base,'evidence/source.json'));if(sha(sourceBytes)!==item.prepared.sourceSha256)throw Error('Source evidence changed');const source=JSON.parse(sourceBytes);for(const entry of item.prepared.files){const bytes=Buffer.from(source.files[entry.path]);await ensure(within(base,entry.path),bytes,entry);hashes.set(entry.sha256,bytes);}}
for(const entry of vendor.files){const target=within(path.join(root,'vendor'),entry.path);const existing=await readFile(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});const bytes=existing??hashes.get(entry.sha256);if(!bytes)throw Error(`Missing pinned vendor asset: ${entry.path}`);await ensure(target,bytes,entry);}
console.log(`Restored ${restored} pinned HyperFrames runtime assets from checked-in evidence`);
