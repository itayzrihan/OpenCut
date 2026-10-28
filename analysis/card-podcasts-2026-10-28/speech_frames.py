import json,subprocess
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;C=ROOT/'.local/card-podcasts-2026-10-28';rows=json.loads((OUT/'acoustic-matches.json').read_text());evidence=[]
for session,clip in [(160,7471),(159,7470),(158,7469),(157,7468)]:
 a,b=[np.load(C/f'240504_{session:04}_{i}.npy') for i in [1,2]];n=min(len(a),len(b))//100*100;a=a[:n].reshape(-1,100).mean(1);b=b[:n].reshape(-1,100).mean(1);ratio=np.log((a+1e-7)/(b+1e-7));valid=(np.arange(len(a))>90)&(np.arange(len(a))<len(a)-90)&(np.maximum(a,b)>np.percentile(np.maximum(a,b),65));ratio[~valid]=np.nan
 times=[int(np.nanargmax(ratio)),int(np.nanargmin(ratio))];sheet=Image.new('RGB',(1200,800),'#202020');d=ImageDraw.Draw(sheet);rec={'session':session,'clip':clip,'moments':[]}
 for mi,t in enumerate(times):
  rec['moments'].append({'dominantMic':mi+1,'microphoneTime':t,'rawRmsRatio':float(np.exp(ratio[t]))})
  for ci,card in enumerate(['A3','A4']):
   row=next(r for r in rows if f'/{card}/' in r['camera'] and f'C{clip}.' in r['camera']);offset=row['matches'][0]['audioStartMinusCameraStart'];base=t+offset
   y=mi*400+ci*200;d.text((4,y+2),f'{session} mic {mi+1} dominant | {card} | mic {t}s camera {base:.2f}s',fill='white')
   for fi,dt in enumerate([0,.2,.4,.6,.8,1.0]):
    target=C/f'{session}-mic{mi+1}-{card}-{fi}.jpg'
    subprocess.run(['ffmpeg','-v','error','-ss',str(base+dt),'-i',row['camera'],'-frames:v','1','-vf','scale=640:360','-y',str(target)],check=True)
    im=Image.open(target);im=im.crop((240,30,440,210));sheet.paste(im,(fi*200,y+20))
 sheet.save(C/f'speech-{session}.jpg');evidence.append(rec);print(rec,flush=True)
(OUT/'speech-moments.json').write_text(json.dumps(evidence,indent=2))
