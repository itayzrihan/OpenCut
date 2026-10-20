"""Run the production Rust precision kernel on bounded windows of episode4 sources."""
import json,subprocess,array
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
P=Path.home()/'Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/3bf1516d-a949-46a0-b631-39089691e736'
media={m['name']:m.get('sourcePath') or str(P/m['storedPath']) for m in json.loads((P/'media/index.json').read_text())}
def pcm(name,start):
 data=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',media[name],'-t','8','-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'])
 a=array.array('f');a.frombytes(data);return a.tolist()
results=[]
for camera,mic,offset in [('C7453lior.MP4','240427_0144_1lior.wav',146.11),('C7456Niva.MP4','240427_0144_2niva.wav',106.31)]:
 for time in [250,750,1200,1700,2100]:
  a=pcm(camera,time)
  for injected in [0,0.1733125]:
   b=pcm(mic,time+offset+injected)
   r=json.loads(subprocess.check_output([str(ROOT/'target/debug/examples/precision_probe')],input=json.dumps({'reference':a,'target':b,'sampleRate':16000}).encode()))
   r.update(camera=camera,time=time,injected=injected);results.append(r);print(json.dumps(r),flush=True)
for i in range(0,len(results),2):
 a,b=results[i:i+2]
 if min(a['confidence'],b['confidence'])>=.12:
  assert abs((b['offsetSeconds']-a['offsetSeconds'])-.1733125)<.005
(ROOT/'analysis/podcast-sync-precision-2026-10-19/real-source-results.json').write_text(json.dumps(results,indent=2)+'\n')
