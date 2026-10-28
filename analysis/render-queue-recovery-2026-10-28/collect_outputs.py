"""Deliver only the seven requested completed outputs; keep native download paths.
No editor/queue state is written. Internal aliases point to verified export files.
"""
from pathlib import Path
import json,hashlib,shutil,os,time,subprocess
P=Path(__file__).resolve().parent
Q=Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/render-queue')
EXTERNAL=Path('/Volumes/HDD 2TB/OpenCut Render Outputs/4fec0688-9a78-4304-849c-9ea937873751')
DEST=Path('/Volumes/HDD 2TB/OpenCut Exports/Event sessions 0149-0156')
DEST.mkdir(parents=True,exist_ok=True)
expected=json.loads((P/'jobs-before.json').read_text());delivered={};states={}
manifest=P/'delivered.json'
if manifest.exists():delivered={r['jobId']:r for r in json.loads(manifest.read_text())}
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
 return h.hexdigest()
deadline=time.time()+6*3600
while time.time()<deadline:
 jobs={j['id']:j for j in json.loads((Q/'runtime.json').read_text())['active']['document']['renderQueue']}
 for e in expected:
  j=jobs[e['id']]
  assert (j['snapshotHash'],j['options'],j['sourceRevision'])==(e['snapshotHash'],e['options'],e['sourceRevision']),e['id']
  status=(j['status'],int(j['progress']*10))
  if states.get(j['id'])!=status:
   print(j['snapshot']['document']['metadata']['name'],j['status'],round(j['progress']*100),flush=True);states[j['id']]=status
  if j['status']!='completed' or j['id'] in delivered:continue
  internal=Q/j['id']/'output.mp4';external=EXTERNAL/j['id']/'output.mp4'
  source=external if external.exists() else internal
  target=DEST/(e['projectName']+'.mp4')
  if not source.exists() and target.exists():source=target
  print('Collecting',target.name,flush=True)
  source_hash=digest(source)
  if not target.exists():
   if source.stat().st_dev==DEST.stat().st_dev:
    os.rename(source,target)
   else:
    temp=target.with_suffix('.mp4.partial');shutil.copy2(source,temp)
    with temp.open('rb') as f:os.fsync(f.fileno())
    assert digest(temp)==source_hash
    os.rename(temp,target)
  # Publish the native download alias as soon as the same-volume rename (or
  # already byte-verified copy) is complete; the final audit may read slowly.
  if source==internal and internal.is_symlink():pass
  else:
   alias=internal.with_suffix('.mp4.alias');alias.unlink(missing_ok=True);alias.symlink_to(target);os.replace(alias,internal)
  assert digest(target)==source_hash
  probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(target)]))
  row={'jobId':j['id'],'projectId':j['projectId'],'projectName':e['projectName'],'path':str(target),'sha256':source_hash,'size':target.stat().st_size,'snapshotHash':j['snapshotHash'],'sourceRevision':j['sourceRevision'],'probe':probe}
  delivered[j['id']]=row
  manifest.write_text(json.dumps(list(delivered.values()),ensure_ascii=False,indent=2)+'\n')
  print('Verified and delivered',target.name,flush=True)
 if len(delivered)==len(expected):print('ALL SEVEN DELIVERED',flush=True);break
 time.sleep(3)
else:raise RuntimeError('Delivery wait expired; remaining jobs are still recorded in canonical queue')
