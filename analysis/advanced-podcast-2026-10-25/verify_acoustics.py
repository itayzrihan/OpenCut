"""Bounded waveform checks for the captured shared clock. Does not edit an editor project."""
import json,subprocess
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).resolve().parent
FOLDER=Path('/Users/itayzrihan/Desktop/Avihay')
subprocess.run(['cargo','build','-q','-p','podcast','--examples'],cwd=ROOT,check=True)
meta=json.loads(subprocess.check_output(['cargo','metadata','--no-deps','--format-version','1'],cwd=ROOT));EXAMPLES=Path(meta['target_directory'])/'debug/examples'
def call(binary,mode,payload):
 args=[str(EXAMPLES/binary)]+([mode] if mode else [])
 return json.loads(subprocess.check_output(args,input=json.dumps(payload).encode()))
records=json.loads((OUT/'recordings.json').read_text())['recordings']
g= json.loads((OUT/'shared-clock.json').read_text());names=g.pop('sources')
grouped=call('advanced_probe','group',dict(recordings=[dict(mediaId=r['name'],name=r['name'],duration=r['durationSeconds'],bindingRevision=0) for r in records]))
(OUT/'detected-groups.json').write_text(json.dumps(grouped,indent=2)+'\n')
assert not grouped['issues'],grouped['issues']
groups={m['recorderToken']:m for m in grouped['microphones']}
camera=json.loads((OUT/'cameras.json').read_text())[0];duration=float(camera['probe']['format']['duration'])
durations=[duration]+[groups[name]['duration'] for name in names[1:]]
windows=call('advanced_probe','plan',dict(alignment=g,durations=durations))
def read(index,start,seconds):
 n=round(seconds*16000)
 if index==0:
  raw=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',str(FOLDER/camera['name']),'-t',str(seconds),'-map','0:a:0','-vn','-ac','1','-ar','16000','-f','f32le','-'])
  result=np.frombuffer(raw,dtype='<f4')
  if len(result)<n:raise ValueError('Incomplete camera window')
  return result[:n].tolist()
 out=np.zeros(n,dtype=np.float32);covered=0
 for segment in groups[names[index]]['segments']:
  r=segment['recording'];lo=max(start,segment['start']);hi=min(start+seconds,segment['start']+r['duration'])
  if hi<=lo:continue
  # All observed WAV files have a 44-byte header, verified by audit_recordings.py.
  offset=round((lo-segment['start'])*48000);count=round((hi-lo)*16000);at=round((lo-start)*16000)
  samples=np.memmap(FOLDER/r['name'],dtype='<f4',mode='r',offset=44+offset*4,shape=(count*3,))
  out[at:at+count]=samples.reshape(-1,3).mean(axis=1);covered+=count
 if covered!=n:raise ValueError('Incomplete microphone waveform window')
 return out.tolist()
estimates=[]
for i,w in enumerate(windows):
 e=call('precision_probe',None,dict(reference=read(w['referenceIndex'],w['referenceStart'],w['durationSeconds']),target=read(w['targetIndex'],w['targetStart'],w['durationSeconds']),sampleRate=16000));estimates.append(e)
 print(json.dumps(dict(window=i,target=names[w['targetIndex']],**e)),flush=True)
result=call('advanced_probe','resolve',dict(alignment=g,windows=windows,estimates=estimates))
(OUT/'precision.json').write_text(json.dumps(dict(sources=names,windows=windows,estimates=estimates,result=result),indent=2)+'\n');print(json.dumps(result),flush=True)
