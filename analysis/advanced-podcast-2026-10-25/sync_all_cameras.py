"""Bounded audio-only decode of cameras referenced in place; shared production Rust clock."""
from pathlib import Path
import json,subprocess,numpy as np
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/advanced-podcast'
items=json.loads((OUT/'all-cameras.json').read_text())
for item in items:
 path=Path(item['path']);cache=CACHE/(path.stem+'-rms-10ms.npy')
 if cache.exists():continue
 before=path.stat();print('Reading '+path.name,flush=True)
 proc=subprocess.Popen(['ffmpeg','-v','error','-i',str(path),'-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','-'],stdout=subprocess.PIPE);blocks=[];pending=b''
 while raw:=proc.stdout.read(1920*1000):
  pending+=raw;n=len(pending)//1920*1920
  if n:
   a=np.frombuffer(pending[:n],dtype='<f4').reshape(-1,480).astype(np.float64);blocks.append(np.sqrt(np.mean(a*a,axis=1)).astype(np.float32));pending=pending[n:]
 if proc.wait():raise RuntimeError('Camera audio failed')
 after=path.stat();assert(before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
 np.save(cache,np.concatenate(blocks))
# Reference order begins with the longest camera, not its preferred editorial angle.
names=[Path(item['path']).stem for item in items[::-1]]+['9P8H','AHQC','AX5F','BCZ9']
payload=dict(envelopes=[np.load(CACHE/(n+'-rms-10ms.npy')).tolist() for n in names],resolutionSeconds=.01,maxLagSeconds=1200)
r=subprocess.run(['cargo','run','-q','-p','podcast','--example','analyze','--','group-align'],cwd=ROOT,input=json.dumps(payload),capture_output=True,text=True,check=True)
g=json.loads(r.stdout);g['sources']=names;(OUT/'all-shared-clock.json').write_text(json.dumps(g,indent=2)+'\n');print(json.dumps(g,indent=2),flush=True)
