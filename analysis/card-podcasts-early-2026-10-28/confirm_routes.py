import json,subprocess,pathlib,numpy as np
from PIL import Image,ImageDraw
P=pathlib.Path(__file__).parent;C=P.parents[1]/'.local/card-podcasts-early-2026-10-28';rows=json.load(open(P/'session-matches.json'));evidence=[]
for session,lo,hi in [(153,100,1350),(154,70,155)]:
 a,b=[np.load(C/f'240504_{session:04}_{i}.npy') for i in [1,2]];n=min(len(a),len(b))//100*100;a=a[:n].reshape(-1,100).mean(1);b=b[:n].reshape(-1,100).mean(1);a=np.convolve(a,np.ones(5)/5,mode='same');b=np.convolve(b,np.ones(5)/5,mode='same');ratio=np.log((a+1e-7)/(b+1e-7));valid=(np.arange(len(a))>=lo)&(np.arange(len(a))<=hi)&(np.maximum(a,b)>np.percentile(np.maximum(a,b),40));ratio[~valid]=np.nan;times=[int(np.nanargmax(ratio)),int(np.nanargmin(ratio))];sheet=Image.new('RGB',(1200,800),'#202020');draw=ImageDraw.Draw(sheet)
 for mi,t in enumerate(times):
  evidence.append(dict(session=session,mic=mi+1,time=t,ratio=float(np.exp(ratio[t]))))
  for ci,card in enumerate(['A1','Untitled']):
   row=next(r for r in rows if f'/{card}/' in r['camera'] and f'C{7460+session-149}.' in r['camera']);base=t+row['matches'][0]['audioStartMinusCameraStart'];y=mi*400+ci*200;draw.text((4,y+2),f'{session} mic{mi+1} {card} mic {t}s camera {base:.2f}s',fill='white');pat=str(C/f'confirm-{session}-{mi}-{ci}-%02d.jpg');subprocess.run(['ffmpeg','-v','error','-ss',str(base),'-i',row['camera'],'-t','2.4','-vf','fps=2.5,scale=640:360','-frames:v','6','-y',pat],check=True)
   for fi in range(6):sheet.paste(Image.open(C/f'confirm-{session}-{mi}-{ci}-{fi+1:02d}.jpg').crop((160,0,480,288)).resize((200,180)),(fi*200,y+20))
 sheet.save(C/f'confirm-{session}.jpg');print(session,times,flush=True)
(P/'route-confirmation-moments.json').write_text(json.dumps(evidence,indent=2))
