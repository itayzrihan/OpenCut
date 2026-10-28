"""Decode representative video/audio windows from each delivered export."""
import json,pathlib,subprocess
from PIL import Image,ImageDraw
base=pathlib.Path(__file__).parent
rows=json.loads((base/'delivered.json').read_text())
frames=base/'frames';frames.mkdir(exist_ok=True)
checks=[]
done={c["jobId"]:c for c in json.loads((base/"media-checks.json").read_text())} if (base/"media-checks.json").exists() else {}
for row in rows:
 name=row["projectName"].split("סשן ")[1][:4]
 if row["jobId"] in done and (frames/f"{name}-contact.jpg").exists():
  checks.append(done[row["jobId"]]);continue
 duration=float(row['probe']['format']['duration']); images=[]
 for label,second in [('start',1),('middle',duration/2),('end',max(1,duration-3))]:
  name=row['projectName'].split('סשן ')[1][:4];dest=frames/f'{name}-{label}.jpg'
  subprocess.run(['ffmpeg','-v','error','-nostdin','-ss',str(second),'-i',row['path'],'-frames:v','1','-vf','scale=480:-2','-y',str(dest)],check=True)
  subprocess.run(['ffmpeg','-v','error','-nostdin','-ss',str(second),'-i',row['path'],'-t','1','-map','0:a:0','-f','null','-'],check=True)
  images.append(Image.open(dest).convert('RGB'))
 canvas=Image.new('RGB',(1440,300),'#181818');draw=ImageDraw.Draw(canvas)
 for i,im in enumerate(images):canvas.paste(im,(i*480,30));draw.text((i*480+8,8),f'{name} - {("start","middle","end")[i]}',fill='white')
 canvas.save(frames/f'{name}-contact.jpg')
 checks.append({'jobId':row['jobId'],'decodedStartMiddleEnd':True,'duration':duration})
(base/'media-checks.json').write_text(json.dumps(checks,indent=2)+'\n')
print(f'PASS: representative video/audio decoded for {len(checks)} exports')
