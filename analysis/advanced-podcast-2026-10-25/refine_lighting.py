from pathlib import Path
import json,subprocess,numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/advanced-podcast/frames'
source=json.loads((OUT/'all-cameras.json').read_text())[1]['path']
def read(start,seconds,fps):
 raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-ss',str(start),'-i',source,'-t',str(seconds),'-vf',f'scale=384:216,fps={fps}','-f','rawvideo','-pix_fmt','rgb24','-'])
 return np.frombuffer(raw,dtype=np.uint8).reshape(-1,216,384,3)
def metrics(frames):
 # Fixed white background above heads. Chroma ratio detects loss of warm light
 # despite automatic exposure raising the wall's luminance afterwards.
 colors=np.median(frames[:,:35,100:320].reshape(len(frames),-1,3).astype(float),axis=1)/255
 return np.column_stack([colors,colors[:,2]/np.maximum(colors[:,0],.01)])
a=read(1080,60,5);m=metrics(a);scores=[]
for i in range(10,len(a)-10):
 before=np.median(m[i-10:i],axis=0);after=np.median(m[i:i+10],axis=0);scores.append((float(np.linalg.norm(after-before)),i))
_,index=max(scores);coarse=1080+index/5;start=round(coarse)-4
frames=read(start,8,25);metric=metrics(frames);difference=np.linalg.norm(np.diff(metric,axis=0),axis=1);indices=np.argsort(difference)[::-1][:12]
result=dict(source=source,fps=25,coarseSeconds=coarse,nativeWindowStart=start,largestSteps=[dict(beforeFrame=round(start*25)+int(i),firstAffectedFrame=round(start*25)+int(i)+1,timeSeconds=start+(int(i)+1)/25,metricDelta=float(difference[i])) for i in indices],frameMetrics=metric.tolist())
(OUT/'lighting-refined.json').write_text(json.dumps(result,indent=2)+'\n');np.save(CACHE/'lighting-native.npy',frames)
chosen=sorted(set([0,len(frames)-1]+[max(0,min(len(frames)-1,int(i)+d)) for i in indices[:2] for d in [-2,-1,0,1,2,5]]));sheet=Image.new('RGB',(384*4,242*((len(chosen)+3)//4)))
for j,i in enumerate(chosen):
 pane=Image.new('RGB',(384,242),'#171717');pane.paste(Image.fromarray(frames[i]),(0,26));ImageDraw.Draw(pane).text((8,7),f'Main {start+i/25:.2f}s | frame {round(start*25)+i}',fill='white');sheet.paste(pane,((j%4)*384,(j//4)*242))
sheet.save(CACHE/'lighting-transition.jpg');print(json.dumps({k:v for k,v in result.items() if k!='frameMetrics'},indent=2),flush=True)
