import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
ev=root/'analysis/teaser-word-fix-2026-10-14'
b=json.loads((ev/'baseline.json').read_text())
p=json.loads(pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/96fa8232-1976-427d-90eb-17cbf11c858c/project.json').read_text())
h=lambda x:hashlib.sha256(json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
assert h(p['settings'])==b['settingsHash'] and h(p['transcriptionJobs'])==b['jobsHash']
for s in p['scenes']:
 if s['id'] in b['protectedScenes']:assert h(s)==b['protectedScenes'][s['id']]
s=next(s for s in p['scenes'] if s['id']==b['sceneId'])
expected=json.loads((root/'.local/teaser-word-fix-2026-10-14/after-document.json').read_text())['scene']
by_id={t['id']:t for t in expected['tracks']}
for t in [*s['tracks']['overlay'],s['tracks']['main'],*s['tracks']['audio']]:
 want=dict(by_id[t['id']]);want.pop('area');assert t==want,t['name']
clips=s['tracks']['main']['elements']
assert len(clips)==12 and clips[1]['duration']==489600 and clips[2]['startTime']==892800
assert all(a['startTime']+a['duration']==z['startTime'] for a,z in zip(clips,clips[1:]))
assert clips[-1]['startTime']+clips[-1]['duration']==10627200
assert json.loads((ev/'tail-audio-check.json').read_text())['correlation']>.8
cues=sorted([e for t in s['tracks']['overlay'] if t.get('captionSource') for e in t['elements']],key=lambda e:e['startTime'])
def ts(t):
 m=round(t/120);return f'{m//3600000:02}:{m//60000%60:02}:{m//1000%60:02},{m%1000:03}'
d=pathlib.Path('/Users/itayzrihan/Downloads')
assert (d/'OpenCut-Teaser-FullAuto-2026-10-14.srt').read_text(encoding='utf-8-sig')=='\n\n'.join(f"{i}\n{ts(e['startTime'])} --> {ts(e['startTime']+e['duration'])}\n{e['params']['content']}" for i,e in enumerate(cues,1))+'\n'
audio=[]
for variant in ['with','without']:
 f=d/f'OpenCut-Teaser-FullAuto-{variant}-captions-2026-10-14.mp4'
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_entries','stream=codec_name,width,height,duration,nb_read_frames','-of','json',str(f)]))['streams']
 assert probe[0]['width']==1080 and probe[0]['height']==1920 and int(probe[0]['nb_read_frames'])==2214
 assert float(probe[0]['duration'])==88.56 and probe[1]['codec_name']=='aac'
 audio.append(hashlib.sha256(subprocess.check_output(['ffmpeg','-v','error','-i',str(f),'-vn','-f','f32le','-'])).hexdigest())
assert audio[0]==audio[1]
manifest=json.loads((root/'analysis/teaser-drive-2026-10-14/manifest.json').read_text())
ui=(root/'analysis/teaser-drive-2026-10-14/uploaded-state.txt').read_text()
assert manifest['folderUrl'] in ui and len(manifest['files'])==4
for f in manifest['files']:
 assert f['name'] in ui and hashlib.sha256(pathlib.Path(f['path']).read_bytes()).hexdigest()==f['sha256']
assert 'Uploading ' not in ui and 'Cancel upload' not in ui
assert (root/'analysis/teaser-drive-2026-10-14/uploaded.png').stat().st_size>10000
print(json.dumps({'passed':True,'seconds':88.56,'videoFrames':2214,'captionCues':len(cues),'protectedScenes':10,'audioIdentical':True,'folder':manifest['folderUrl']}))
