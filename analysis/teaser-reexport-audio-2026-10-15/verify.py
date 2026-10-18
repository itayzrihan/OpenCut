import json,pathlib,hashlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
ev=pathlib.Path(__file__).parent
before=json.loads((root/'.local/teaser-reexport-audio-2026-10-15/project-before.json').read_text())
after=json.loads(pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/96fa8232-1976-427d-90eb-17cbf11c858c/project.json').read_text())
assert before['scenes']==after['scenes']
assert before['settings']==after['settings']
assert before.get('transcriptionJobs')==after.get('transcriptionJobs')
scene=next(s for s in after['scenes'] if s['id']=='6125f350-cad1-4f95-b7b6-8cc507c24af7')
cues=sorted([e for t in scene['tracks']['overlay'] if t.get('captionSource') for e in t['elements']],key=lambda e:e['startTime'])
assert len(cues)==69 and all(not t.get('hidden') for t in scene['tracks']['overlay'])
def ts(t):
 m=round(t/120);return f'{m//3600000:02}:{m//60000%60:02}:{m//1000%60:02},{m%1000:03}'
expected='\n\n'.join(f"{i}\n{ts(e['startTime'])} --> {ts(e['startTime']+e['duration'])}\n{e['params']['content']}" for i,e in enumerate(cues,1))+'\n'
manifest=json.loads((ev/'manifest.json').read_text())
audio=[]
for f in manifest['files']:
 p=pathlib.Path(f['path']);assert hashlib.sha256(p.read_bytes()).hexdigest()==f['sha256']
 state=(ev/f"drive-{f['variant']}-version.txt").read_text()
 assert f['name'] in state.split('generic: Current version',1)[1].split('generic: Version',1)[0]
 assert 'Uploading…' not in state and 'Cancel upload' not in state
 if f['variant']=='srt':
  assert p.read_text(encoding='utf-8-sig')==expected
  continue
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_entries','stream=codec_name,width,height,r_frame_rate,duration,nb_read_frames','-of','json',str(p)]))['streams']
 assert (probe[0]['codec_name'],probe[0]['width'],probe[0]['height'],probe[0]['r_frame_rate'])==('h264',1080,1920,'25/1')
 assert int(probe[0]['nb_read_frames'])==2093 and float(probe[0]['duration'])==83.72
 assert probe[1]['codec_name']=='aac' and abs(float(probe[1]['duration'])-83.72)<.1
 audio.append(hashlib.sha256(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-vn','-f','f32le','-'])).hexdigest())
assert audio[0]==audio[1]
assert max(c['startTime']+c['duration'] for c in cues)/120000<=83.72
assert json.loads((ev/'audio-source-check.json').read_text())['sourceSpeechCorrelation']>.95
assert (ev/'with-captions.jpg').read_bytes()!=(ev/'without-captions.jpg').read_bytes()
assert (ev/'uploaded.png').stat().st_size>10000
print(json.dumps({'passed':True,'videoSeconds':83.72,'videoFrames':2093,'captionCues':69,'sceneStatePreserved':True,'audioIdentical':True,'driveVersionsUpdated':3}))
