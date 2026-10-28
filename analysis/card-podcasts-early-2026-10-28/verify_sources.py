"""Independent waveform and visible speech evidence; reads cards without altering them."""
import json,subprocess,concurrent.futures
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent;CACHE=ROOT/'.local/card-podcasts-early-2026-10-28'
rows=json.loads((OUT/'session-matches.json').read_text())
def pcm(p,t):
 return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-ss',str(t),'-i',p,'-t','8','-vn','-ac','1','-ar','16000','-f','f32le','-']),dtype='<f4')
def verify(row):
 match=row['matches'][0]; offset=match['audioStartMinusCameraStart']; estimates=[]
 duration=next(float(x['probe']['format']['duration']) for x in json.loads((OUT/'inventory.json').read_text()) if x['path']==row['camera'])
 for t in [max(90,round(duration*.2)),round(duration*.5),round(duration*.8)]:
  a=pcm(row['camera'],t);b=pcm(match['path'],t-offset);n=min(len(a),len(b))
  result=json.loads(subprocess.check_output([str(ROOT/'target/debug/examples/precision_probe')],input=json.dumps({'reference':a[:n].tolist(),'target':b[:n].tolist(),'sampleRate':16000}).encode()))
  estimates.append(dict(cameraTime=t,microphoneTime=t-offset,**result))
 result=dict(camera=row['camera'],audio=match['path'],coarseOffset=offset,estimates=estimates)
 print(json.dumps(result),flush=True);return result
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(verify,rows))
(OUT/'precision-evidence.json').write_text(json.dumps(results,indent=2))
