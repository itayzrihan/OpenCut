"""Read-only source evidence. Small RMS caches, never copies/changes card media."""
import concurrent.futures,json,re,subprocess,wave
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
CACHE=ROOT/'.local/card-podcasts-2026-10-28'
items=json.loads((OUT/'inventory.json').read_text())
selected=[x for x in items if x['kind']=='camera' or int(Path(x['path']).name.split('_')[1])>=157]
def key(x):
 p=Path(x['path']);return (p.parts[2]+'-'+p.stem) if x['kind']=='camera' else p.stem
def read(x):
 p=Path(x['path']);dst=CACHE/(key(x)+'.npy')
 if dst.exists():return
 before=p.stat();blocks=[]
 print('Reading '+str(p),flush=True)
 if x['kind']=='microphone':
  with wave.open(str(p),'rb') as f:
   assert f.getsampwidth()==3 and f.getnchannels()==1 and f.getframerate()==48000
   while raw:=f.readframes(480*2000):
    a=np.frombuffer(raw,dtype=np.uint8).reshape(-1,3).astype(np.int32)
    a=(a[:,0]|a[:,1]<<8|a[:,2]<<16);a=(a ^ 0x800000)-0x800000
    n=len(a)//480*480
    if n:blocks.append(np.sqrt(np.mean((a[:n].reshape(-1,480).astype(np.float64)/8388608)**2,axis=1)).astype(np.float32))
 else:
  raw=subprocess.check_output(['ffmpeg','-v','error','-ss','60','-i',str(p),'-t','90','-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','-'])
  a=np.frombuffer(raw,dtype='<f4');n=len(a)//480*480
  blocks=[np.sqrt(np.mean(a[:n].reshape(-1,480).astype(np.float64)**2,axis=1)).astype(np.float32)]
 np.save(dst,np.concatenate(blocks))
 after=p.stat();assert (before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
 print('Cached '+key(x),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as e:list(e.map(read,selected))
def correlate(ref,target):
 m=len(ref);n=len(target);size=1<<(n+m-1).bit_length();r=ref.astype(float)-np.mean(ref)
 dot=np.fft.irfft(np.fft.rfft(target,size)*np.fft.rfft(r[::-1],size),size)[m-1:n]
 a=np.r_[0,np.cumsum(target,dtype=float)];b=np.r_[0,np.cumsum(target.astype(float)**2)]
 var=np.maximum(0,b[m:]-b[:-m]-(a[m:]-a[:-m])**2/m)
 score=dot/np.maximum(np.sqrt(var*np.sum(r*r)),1e-20);at=int(np.argmax(score))
 return dict(score=float(score[at]),microphoneWindowStart=at*.01,audioStartMinusCameraStart=60-at*.01)
results=[]
for c in [x for x in selected if x['kind']=='camera']:
 ref=np.load(CACHE/(key(c)+'.npy'))
 matches=[dict(path=x['path'],**correlate(ref,np.load(CACHE/(key(x)+'.npy')))) for x in selected if x['kind']=='microphone']
 matches.sort(key=lambda x:x['score'],reverse=True);results.append(dict(camera=c['path'],matches=matches))
 print(json.dumps(dict(camera=c['path'],matches=matches[:3])),flush=True)
(OUT/'acoustic-matches.json').write_text(json.dumps(results,indent=2)+'\n')
