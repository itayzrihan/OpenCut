from pathlib import Path
import json,subprocess,numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/advanced-podcast/frames'
items=json.loads((OUT/'all-cameras.json').read_text());g=json.loads((OUT/'all-shared-clock.json').read_text());offsets=dict(zip(g['sources'],g['offsets']));common=1123.32+offsets[Path(items[1]['path']).stem];result=[];sheets=[]
for ci,item in enumerate(items):
 source=item['path'];expected=common-offsets[Path(source).stem];start=int(expected)-1
 raw=subprocess.check_output(['ffmpeg','-v','error','-threads','2','-ss',str(start),'-i',source,'-t','3','-vf','scale=384:216','-f','rawvideo','-pix_fmt','rgb24','-'])
 a=np.frombuffer(raw,dtype=np.uint8).reshape(-1,216,384,3);np.save(CACHE/f'camera{ci}-native-light.npy',a)
 # Median across fixed top-background tiles avoids foreground hand motion.
 roi=a[:,:30,100:320].reshape(len(a),-1,3).astype(float)/255;colors=np.median(roi,axis=1)
 d=np.linalg.norm(np.diff(colors,axis=0),axis=1);rank=np.argsort(d)[::-1];top=int(rank[0]);before=colors[:10].mean(axis=0);deviation=np.linalg.norm(colors-before,axis=1)
 candidates=[i for i in range(1,len(a)-5) if deviation[i]>.025 and (deviation[i:i+5]>.025).all()];onset=candidates[0] if candidates else top+1
 result.append(dict(path=source,fps=25,windowStart=start,firstAffectedFrame=start*25+onset,firstAffectedSeconds=start+onset/25,largestStepSeconds=start+(top+1)/25,steps=[dict(time=start+(int(i)+1)/25,delta=float(d[i])) for i in rank[:6]]))
 chosen=list(range(max(0,onset-3),min(len(a),onset+5)))+[len(a)-1]
 sheet=Image.new('RGB',(384*3,242*3))
 for j,i in enumerate(chosen):
  pane=Image.new('RGB',(384,242),'#171717');pane.paste(Image.fromarray(a[i]),(0,26));ImageDraw.Draw(pane).text((8,7),f'Camera {ci} | {start+i/25:.2f}s | frame {start*25+i}',fill='white');sheet.paste(pane,((j%3)*384,(j//3)*242))
 sheet.save(CACHE/f'camera{ci}-light-boundary.jpg')
(OUT/'light-boundaries.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
