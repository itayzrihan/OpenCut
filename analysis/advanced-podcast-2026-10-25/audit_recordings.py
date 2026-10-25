"""Read-only, bounded inspection of a growing recorder folder. Requires numpy/ffmpeg.
Usage: python3 audit_recordings.py SOURCE_FOLDER [--camera]
Writes small evidence JSON beside this script; derived envelopes stay in .local.
"""
import argparse, json, struct, subprocess, re, hashlib
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
CACHE=ROOT/'.local/advanced-podcast';CACHE.mkdir(parents=True,exist_ok=True)
p=argparse.ArgumentParser();p.add_argument('folder',type=Path);p.add_argument('--camera',action='store_true');args=p.parse_args()
records=[];groups={};issues=[]
for path in sorted(args.folder.glob('*.wav')):
 before=path.stat();meta={};chunks=[];data_info=None
 with path.open('rb') as f:
  if f.read(12)[:4]!=b'RIFF':raise ValueError(f'Unsupported WAV: {path}')
  while h:=f.read(8):
   if len(h)!=8:raise ValueError(f'Incomplete WAV header: {path}')
   tag,n=struct.unpack('<4sI',h);at=f.tell();chunks.append(tag.decode(errors='replace'))
   if at+n>before.st_size:raise ValueError(f'Still copying/truncated: {path.name}')
   if tag==b'fmt ':fmt=struct.unpack('<HHIIHH',f.read(16))
   if tag==b'data':data_info=(at,n)
   if tag in [b'bext',b'iXML',b'LIST',b'axml']:meta[tag.decode()]=f.read(min(n,16384)).decode(errors='replace')
   f.seek(at+n+(n%2))
  f.seek(0);header_hash=hashlib.sha256(f.read(44)).hexdigest()
 if not data_info or fmt!=(3,1,48000,192000,4,32):raise ValueError(f'Unexpected audio format: {path.name}: {fmt}')
 at,n=data_info;data=np.memmap(path,dtype='<f4',mode='r',offset=at,shape=(n//4,));blocks=len(data)//480
 env=np.empty(blocks,dtype=np.float32);peak=0.
 for start in range(0,blocks,1000):
  end=min(start+1000,blocks);a=np.asarray(data[start*480:end*480]).reshape(-1,480).astype(np.float64)
  if not np.isfinite(a).all():raise ValueError(f'Non-finite samples: {path.name}')
  peak=max(peak,float(np.abs(a).max()));env[start:end]=np.sqrt(np.mean(a*a,axis=1))
 after=path.stat()
 if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError(f'Changed while inspecting: {path.name}')
 match=re.fullmatch(r'(\d{8})_(\d{4})_(\d{4})_32Float_([A-Za-z0-9]{4})[\w -]*\.wav',path.name)
 if not match:issues.append('Unrecognized filename: '+path.name);continue
 date,minute,seq,token=match.groups();groups.setdefault(token,[]).append((int(seq),env))
 records.append(dict(name=path.name,bytes=before.st_size,samples=len(data),sampleRate=48000,channels=1,format='IEEE float32',durationSeconds=len(data)/48000,recorderToken=token,sequence=int(seq),metadataChunks=chunks,metadata=meta,samplePeak=peak,headerSha256=header_hash))
for token,entries in groups.items():
 entries.sort(key=lambda e:e[0]);np.save(CACHE/(token+'-rms-10ms.npy'),np.concatenate([e for _,e in entries]))
 if any(b[0]!=a[0]+1 for a,b in zip(entries,entries[1:])):issues.append('Missing or duplicate segment: '+token)
(OUT/'recordings.json').write_text(json.dumps(dict(recordings=records,issues=issues),indent=2)+'\n')
print(json.dumps(dict(recordings=len(records),tokens=sorted(groups),issues=issues)),flush=True)
if args.camera:
 cameras=[]
 for path in sorted(args.folder.glob('*')):
  if path.suffix.lower() not in ['.mp4','.mov']:continue
  before=path.stat();probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size:stream=index,codec_type,codec_name,sample_rate,channels:stream_tags=timecode','-of','json',str(path)]))
  print('Reading camera audio: '+path.name,flush=True)
  proc=subprocess.Popen(['ffmpeg','-v','error','-i',str(path),'-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','-'],stdout=subprocess.PIPE)
  chunks=[];pending=b''
  while raw:=proc.stdout.read(480*4*1000):
   pending+=raw;n=len(pending)//1920*1920
   if n:
    a=np.frombuffer(pending[:n],dtype='<f4').reshape(-1,480).astype(np.float64);chunks.append(np.sqrt(np.mean(a*a,axis=1)).astype(np.float32));pending=pending[n:]
  if proc.wait()!=0:raise ValueError('Camera decode failed: '+path.name)
  after=path.stat()
  if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('Camera changed while reading: '+path.name)
  np.save(CACHE/(path.stem+'-rms-10ms.npy'),np.concatenate(chunks));cameras.append(dict(name=path.name,probe=probe))
 (OUT/'cameras.json').write_text(json.dumps(cameras,indent=2)+'\n')
