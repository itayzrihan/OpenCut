"""Read-only coarse illumination scan; decode individual frames from source paths."""
from pathlib import Path
import json,subprocess,numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/advanced-podcast/frames'
items=json.loads((OUT/'all-cameras.json').read_text());result=[]
for ci,item in enumerate(items):
 source=item['path'];duration=float(item['probe']['format']['duration']);rows=[]
 for t in range(60,int(duration)-30,60):
  path=CACHE/f'camera{ci}-{t:04}.png'
  if not path.exists():
   subprocess.run(['ffmpeg','-v','error','-threads','2','-ss',str(t),'-i',source,'-frames:v','1','-vf','scale=384:216','-y',str(path)],check=True)
  a=np.asarray(Image.open(path).convert('RGB'),dtype=float)/255
  tiles=a.reshape(9,24,16,24,3).mean(axis=(1,3));luma=tiles@np.array([.2126,.7152,.0722])
  rows.append(dict(time=t,meanRGB=a.mean(axis=(0,1)).tolist(),tileRGB=tiles.tolist(),luma=float(luma.mean())))
  if t%600==0:print(f'camera {ci}: {t}/{duration:.2f}',flush=True)
 # Rank sustained tile changes, not a passing foreground gesture.
 changes=[]
 for i in range(2,len(rows)-2):
  before=np.median([r['tileRGB'] for r in rows[i-2:i]],axis=0);after=np.median([r['tileRGB'] for r in rows[i:i+2]],axis=0)
  diff=(after-before)@np.array([.2126,.7152,.0722]);changes.append(dict(start=rows[i-1]['time'],end=rows[i]['time'],medianChange=float(np.median(diff)),negativeFraction=float(np.mean(diff<-.025)),score=float(np.median(np.abs(diff)))))
 changes.sort(key=lambda c:c['score'],reverse=True)
 result.append(dict(source=source,rows=rows,candidates=changes[:8]));print(json.dumps(dict(camera=ci,source=source,candidates=changes[:5])),flush=True)
 (OUT/'lighting-coarse.json').write_text(json.dumps(result,indent=2)+'\n')
 thumbs=[]
 for t in [300,1800,3000,4200]:
  image=Image.open(CACHE/f'camera{ci}-{t:04}.png').convert('RGB');pane=Image.new('RGB',(384,242),'#171717');pane.paste(image,(0,26));ImageDraw.Draw(pane).text((8,7),f'Camera {ci} | {t//60:02}:{t%60:02}',fill='white');thumbs.append(pane)
 sheet=Image.new('RGB',(384*2,242*2));
 for i,im in enumerate(thumbs):sheet.paste(im,((i%2)*384,(i//2)*242))
 sheet.save(CACHE/f'camera{ci}-contact.jpg')
