// Generated deployment artifacts only. Never inspect or remove account/media data.
import {readdir, readFile, lstat, rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
const releaseName=/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
export async function pruneReleases({deploymentRoot, releasesRoot=join(deploymentRoot,'releases'), keepRecent=3, dryRun=false}) {
  if (!Number.isInteger(keepRecent) || keepRecent < 1) throw Error('Keep at least one recent release');
  const root=resolve(releasesRoot);
  const releases=[];
  for(const name of await readdir(root)) {
    if(!releaseName.test(name)) continue;
    const path=join(root,name);
    if(!(await lstat(path)).isDirectory()) continue;
    try {
      const metadata=JSON.parse(await readFile(join(path,'release.json'),'utf8'));
      if(metadata.id===name) releases.push(name);
    } catch { /* Unknown or incomplete directories are never pruned. */ }
  }
  releases.sort().reverse();
  const protectedIds=new Set(releases.slice(0,keepRecent));
  for(const name of ['current.json','previous.json','candidate.json']) {
    try { protectedIds.add(JSON.parse(await readFile(join(deploymentRoot,name),'utf8')).id); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const removed=[];
  for(const id of releases) {
    if(protectedIds.has(id)) continue;
    const target=resolve(root,id), rel=relative(resolve(root),target);
    if(!rel||rel.startsWith('..')||isAbsolute(rel)) throw Error('Release cleanup path escaped its directory');
    if(!dryRun) await rm(target,{recursive:true});
    removed.push(id);
  }
  return {removed,retained:releases.filter(id=>protectedIds.has(id)),dryRun};
}
