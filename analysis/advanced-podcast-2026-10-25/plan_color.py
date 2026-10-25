"""Measure a restrained editable grade in the existing native color-correction controls.
No LUT or altered source files. CPU images use the checked-in WGSL transfer equation.
"""
from pathlib import Path
import json,subprocess,numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/advanced-podcast/frames'
items=json.loads((OUT/'light-boundaries.json').read_text());plans=[]
def frame(path,time):
 raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-ss',str(time),'-i',path,'-frames:v','1','-vf','scale=768:432','-f','rawvideo','-pix_fmt','rgb24','-'])
 return np.frombuffer(raw,dtype=np.uint8).reshape(432,768,3).astype(float)/255
matrix=np.array([[1,.6,.2],[1,0,-.4],[1,-.6,.2]])
def grade(a,p):
 linear=a**2.2;e,t,ti=p['exposure'],p['temperature']/100,p['tint']/100
 gain=2**(matrix@np.array([e,t,ti]));adjusted=linear*gain/(1+linear*(gain-1));luma=adjusted@np.array([.2126,.7152,.0722]);rgb=luma[:,:,None]+(adjusted-luma[:,:,None])*p['saturation']/100
 return np.clip(rgb,0,1)**(1/2.2)
def params_after(before,after,base):
 target=before**2.2;source=after**2.2
 # Exclude clipping and deep noise. Background is a majority; median rejects motion.
 mask=(before.min(axis=2)>.10)&(before.max(axis=2)<.90)&(after.min(axis=2)>.07)&(after.max(axis=2)<.95)
 gain=target*(1-source)/np.maximum(source*(1-target),1e-9)
 log=np.median(np.log2(np.maximum(gain[mask],1e-6)),axis=0)
 extra=np.linalg.solve(matrix,log);return dict(exposure=round(float(np.clip(base['exposure']+extra[0],-1.5,1.5)),3),temperature=round(float(np.clip(base['temperature']+extra[1]*100,-65,65)),2),tint=round(float(np.clip(base['tint']+extra[2]*100,-45,45)),2),saturation=base['saturation'])
for ci,item in enumerate(items):
 path=item['path'];onset=item['firstAffectedSeconds'];baseline=dict(exposure=.10,temperature=-5.,tint=0.,saturation=98.)
 before=frame(path,onset-.12);points=[dict(sourceSeconds=0,params=baseline),dict(sourceSeconds=onset-.04,params=baseline)]
 times=[0,.04,.4,.8,1.2,2.,3.,5.,8.,12.]
 for d in times:
  after=frame(path,onset+d);p=params_after(before,after,baseline);points.append(dict(sourceSeconds=round(onset+d,2),params=p))
 settled=frame(path,onset+12);correctedbefore=grade(before,baseline);correctedafter=grade(settled,points[-1]['params'])
 plans.append(dict(path=path,effectType='color-correction',onsetSourceSeconds=onset,gradePoints=points,baseline=baseline,settled=points[-1]['params'],note='Global exposure/white-balance match with restrained podcast polish; cannot reconstruct direction of missing light.'))
 sheet=Image.new('RGB',(768*2,458*2));images=[(before,'Before light change · original'),(settled,'After light change · original'),(correctedbefore,'Before · podcast grade'),(correctedafter,'After · matched native grade')]
 for j,(a,label) in enumerate(images):
  pane=Image.new('RGB',(768,458),'#171717');pane.paste(Image.fromarray(np.uint8(np.rint(a*255))),(0,26));ImageDraw.Draw(pane).text((8,7),label,fill='white');sheet.paste(pane,((j%2)*768,(j//2)*458))
 sheet.save(CACHE/f'camera{ci}-grade-comparison.jpg');print(json.dumps(dict(camera=ci,baseline=baseline,settled=points[-1]['params'])),flush=True)
(OUT/'color-plan.json').write_text(json.dumps(plans,indent=2)+'\n')
