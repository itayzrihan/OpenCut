import json,pathlib,subprocess,numpy as np
P=pathlib.Path(__file__).parent;C=P.parents[1]/'.local/card-podcasts-early-2026-10-28';items=json.load(open(P/'inventory.json'));results=[]
def correlate(ref,target,start):
 m=len(ref);n=len(target);size=1<<(n+m-1).bit_length();r=ref.astype(float)-np.mean(ref)
 dot=np.fft.irfft(np.fft.rfft(target,size)*np.fft.rfft(r[::-1],size),size)[m-1:n]
 a=np.r_[0,np.cumsum(target,dtype=float)];b=np.r_[0,np.cumsum(target.astype(float)**2)];var=np.maximum(0,b[m:]-b[:-m]-(a[m:]-a[:-m])**2/m)
 score=dot/np.maximum(np.sqrt(var*np.sum(r*r)),1e-20);at=int(np.argmax(score));return dict(score=float(score[at]),audioStartMinusCameraStart=start-at*.01)
for camera in [x for x in items if x['kind']=='camera' and 'C7460.' in x['path']]:
 for start in [300,900,1500]:
  raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',camera['path'],'-t','60','-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','-']);a=np.frombuffer(raw,dtype='<f4');n=len(a)//480*480;ref=np.sqrt(np.mean(a[:n].reshape(-1,480).astype(float)**2,axis=1)).astype(np.float32)
  matches=[dict(path=x['path'],**correlate(ref,np.load(C/(pathlib.Path(x['path']).stem+'.npy')),start)) for x in items if x['kind']=='microphone'];matches.sort(key=lambda x:x['score'],reverse=True);r=dict(camera=camera['path'],start=start,matches=matches);results.append(r);print(json.dumps(dict(camera=camera['path'],start=start,matches=matches[:3])),flush=True)
(P/'first-session-windows.json').write_text(json.dumps(results,indent=2))
