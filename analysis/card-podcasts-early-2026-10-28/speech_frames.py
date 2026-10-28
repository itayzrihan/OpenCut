import json,subprocess,pathlib,numpy as np
from PIL import Image,ImageDraw
P=pathlib.Path(__file__).parent;C=P.parents[1]/'.local/card-podcasts-early-2026-10-28';rows=json.load(open(P/'session-matches.json'));evidence=[]
for session in range(149,157):
 clip=7460+session-149;a,b=[np.load(C/f'240504_{session:04}_{i}.npy') for i in [1,2]];n=min(len(a),len(b))//100*100;a=a[:n].reshape(-1,100).mean(1);b=b[:n].reshape(-1,100).mean(1);ratio=np.log((a+1e-7)/(b+1e-7));margin=30 if len(a)<400 else 90;valid=(np.arange(len(a))>margin)&(np.arange(len(a))<len(a)-margin)&(np.maximum(a,b)>np.percentile(np.maximum(a,b),65));ratio[~valid]=np.nan
 times=[int(np.nanargmax(ratio)),int(np.nanargmin(ratio))];sheet=Image.new('RGB',(1200,800),'#202020');draw=ImageDraw.Draw(sheet);rec=dict(session=session,clip=clip,moments=[])
 for mi,t in enumerate(times):
  rec['moments'].append(dict(dominantMic=mi+1,microphoneTime=t,rawRmsRatio=float(np.exp(ratio[t]))))
  for ci,card in enumerate(['A1','Untitled']):
   row=next(r for r in rows if f'/{card}/' in r['camera'] and f'C{clip}.' in r['camera']);base=t+row['matches'][0]['audioStartMinusCameraStart'];y=mi*400+ci*200;draw.text((4,y+2),f'{session} mic {mi+1} dominant | {card} | mic {t}s camera {base:.2f}s',fill='white')
   pattern=str(C/f'{session}-mic{mi+1}-{card}-%02d.jpg');subprocess.run(['ffmpeg','-v','error','-ss',str(base),'-i',row['camera'],'-t','1.2','-vf','fps=5,scale=640:360','-frames:v','6','-y',pattern],check=True)
   for fi in range(6):
    im=Image.open(C/f'{session}-mic{mi+1}-{card}-{fi+1:02d}.jpg');sheet.paste(im.crop((160,0,480,288)).resize((200,180)),(fi*200,y+20))
 sheet.save(C/f'speech-{session}.jpg');evidence.append(rec);print(rec,flush=True)
(P/'speech-moments.json').write_text(json.dumps(evidence,indent=2))
