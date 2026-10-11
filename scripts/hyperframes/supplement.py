# Capture only missing official catalog identities; preserve reviewed OpenCut entries.
# Usage: python3 scripts/hyperframes/supplement.py <official-source.tar.gz> <commit>
import tarfile,json,pathlib,hashlib,sys,re
archive=pathlib.Path(sys.argv[1]).resolve(); commit=sys.argv[2]
if not re.fullmatch(r"[a-f0-9]{40}",commit): raise ValueError("An exact upstream SHA is required")
repo=pathlib.Path(__file__).resolve().parents[2]
root=repo/'resources/hyperframes'; base=json.loads((root/'catalog.json').read_text()); prefix=f'hyperframes-{commit}/'
hash=lambda b:hashlib.sha256(b).hexdigest()
with tarfile.open(archive) as tar:
 members={m.name[len(prefix):]:m for m in tar.getmembers() if m.isfile() and m.name.startswith(prefix)}
 for name in members:
  if any(part in ('..','.') for part in name.split('/')) or name.startswith('/') or '\\' in name: raise ValueError('Unsafe archive path')
 read=lambda p:tar.extractfile(members[p]).read()
 registry=read('registry/registry.json'); refs=json.loads(registry)['items']; old={i['id'] for i in base['items']}; items=[]
 folders={'block':'blocks','component':'components','example':'examples'}
 dest=root/'upstream'/commit; dest.mkdir(parents=True,exist_ok=True)
 for p in ['LICENSE','registry/registry.json']:
  out=dest/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(read(p))
 for ref in refs:
  if ref['name'] in old: continue
  kind=ref['type'].split(':')[1]; p=f"registry/{folders[kind]}/{ref['name']}"; files=[]
  for name in sorted(n for n in members if n.startswith(p+'/')):
   relative=name[len(p)+1:]; data=read(name)
   if len(data)>32*1024*1024: raise Exception('Oversize '+name)
   out=dest/name;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
   files.append(dict(path=relative,bytes=len(data),sha256=hash(data)))
  m=json.loads(read(p+'/registry-item.json')); manifest=next(f['sha256'] for f in files if f['path']=='registry-item.json')
  prompt=m.get('sourcePrompt'); missing=[f['path'] for f in m.get('files',[]) if f['path'] not in {x['path'] for x in files}]
  items.append(dict(id=ref['name'],kind=kind,title=m.get('title',ref['name']),description=m.get('description',''),tags=m.get('tags',[]),dimensions=m.get('dimensions'),durationSeconds=m.get('duration'),parameters=m.get('params',[]),variables=m.get('variables'),registryDependencies=m.get('registryDependencies',[]),sourcePath=f'upstream/{commit}/{p}',sourceUrl=f'https://github.com/heygen-com/hyperframes/tree/{commit}/{p}',manifestSha256=manifest,files=files,declaredFiles=m.get('files',[]),preview=m.get('preview'),licensePaths=['LICENSE'],prompt=dict(status='original' if prompt else 'unreviewed',text=prompt,provenance=dict(upstreamCommit=commit,path=p+'/registry-item.json',field='sourcePrompt') if prompt else None),popularity=None,verification=dict(status='captured',missingDeclaredFiles=missing,dependencyClosure=False,preview=False,reopen=False,transparentOverlay=None,**{"import":False})))
 result=dict(schemaVersion=1,upstreamCommit=commit,registrySha256=hash(registry),registryUrl=f'https://raw.githubusercontent.com/heygen-com/hyperframes/{commit}/registry/registry.json',items=items)
 (root/'catalog-supplement.json').write_text(json.dumps(result,indent=2)+'\n')
 print(dict(original=len(old),official=len(refs),added=len(items),union=len(old)+len(items),files=sum(len(i['files']) for i in items)))
