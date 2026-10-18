"""Reproducible, source-frame aligned extraction; no gain or tail processing."""
import hashlib,json,subprocess,datetime,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parent
SOURCE=Path('/tmp/codex-remote-attachments/01a13d23-cc18-76f0-8e1a-cf3e55972277/2FDF740B-7745-4A23-8143-07691762B282/1-530c8b835d42449d9cb0742cd2a01ab3.mp4')
# Limits enclose the complete -60 dBFS envelope, rounded OUTWARD to source frames.
# Digital Text/Riser use the short -38 dBFS quiet valley, not silence within either effect.
RANGES=[('8 Bit Talking',0,2.40),('Old Flash',2.48,3.60),('Cinematic Woosh',3.92,6.40),('Night Vision',6.60,8.28),('Nextel',8.44,8.84),('Digital Text',8.96,9.52),('Riser',9.52,13.64),('Counter',13.92,14.84),('Bicycle Chain',14.92,15.60),('Camera Click',16.16,16.88),('Shine',17.04,18.20),('Woosh',18.44,19.48)]
frames=json.loads((ROOT/'frame-times.json').read_text())
out=ROOT/'mp3';out.mkdir(exist_ok=True)
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
assets=[];ledger=[]
for i,(name,a,b) in enumerate(RANGES,1):
 slug=name.lower().replace(' ','-'); file=out/f'{slug}.mp3'
 assert min(abs(t-a) for t in frames)<.00001 and min(abs(t-b) for t in frames)<.00001
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(SOURCE),'-vn','-af',f'atrim=start={a}:end={b},asetpts=PTS-STARTPTS','-c:a','libmp3lame','-b:a','320k','-ar','44100','-ac','2','-metadata',f'title={name}','-metadata','album=Mr.Biss Sounds You Need','-metadata','artist=Mr.Biss',str(file)],check=True)
 sha=hashlib.sha256(file.read_bytes()).hexdigest()
 assets.append(dict(id=f'mrbiss-530c8b83-{slug}',name=name,folder='sfx',pack='Mr.Biss · Sounds You Need',mimeType='audio/mpeg',size=file.stat().st_size,duration=round(b-a,6),fileName=file.name,sourceFile=str(file),sha256=sha,createdAt=now,updatedAt=now,license={'status':'needs-review','author':'Mr.Biss (@MR.BISS)','note':'Extracted from user-supplied video 530c8b835d42449d9cb0742cd2a01ab3.mp4. Source does not establish a redistribution or commercial-use license.'}))
 ledger.append(dict(name=name,start=a,end=b,startFrame=frames.index(a),endFrameExclusive=frames.index(b),sha256=sha,file=str(file.relative_to(ROOT))))
# An additional unlabelled sound plays under the end card, after all 12 visual samples.
# Preserve it separately without inventing a source label or publishing an unknown outro as a named effect.
subprocess.run(['ffmpeg','-v','error','-y','-i',str(SOURCE),'-vn','-af','atrim=start=19.94:end=21.48,asetpts=PTS-STARTPTS','-c:a','libmp3lame','-b:a','320k',str(ROOT/'unlabelled-outro.mp3')],check=True)
(ROOT/'catalog.json').write_text(json.dumps({'audioAssets':assets},ensure_ascii=False,indent=2))
(ROOT/'ranges.json').write_text(json.dumps({'source':str(SOURCE),'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'audioPolicy':'No normalization, denoising, added fades, time stretching or stereo changes; tails retained to -60dBFS quiet gaps. Source visual labels override internal acoustic pauses. Short 9.497–9.555s quiet valley separates Digital Text from Riser.','effects':ledger,'unlabelledOutro':{'start':19.94,'end':21.48,'published':False,'reason':'No effect label; end-card audio is preserved separately.'}},ensure_ascii=False,indent=2))
print(json.dumps(ledger,indent=2))
