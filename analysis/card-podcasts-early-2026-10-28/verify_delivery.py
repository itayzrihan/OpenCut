"""Read-only checks for the eight native regular podcasts and local audio custody."""
import json, hashlib
from pathlib import Path
P=Path(__file__).resolve().parent
ROOT=Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects')
mapping=json.loads((P/'verified-mapping.json').read_text())
copies=json.loads((P/'local-audio-copy.json').read_text())
projects=json.loads((P/'projects.json').read_text())
assert len(copies['files'])==24
for c in copies['files']:
 assert c['verified'] and Path(c['local']).stat().st_size==c['size']
 h=hashlib.sha256()
 with open(c['local'],'rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 assert h.hexdigest()==c['sha256']
assert len(projects)==8
for guard in json.loads((P/'previous-project-guards.json').read_text()):
 old=json.loads((ROOT/guard['projectId']/'project.json').read_text())
 data={k:old[k] for k in ['scenes','settings']}
 assert hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()==guard['scenesAndSettingsSha256']
 oldmedia=json.loads((ROOT/guard['projectId']/'media/index.json').read_text())
 assert all(a['sourcePath'].startswith(copies['destination']+'/') for a in oldmedia if a['type']=='audio')
for m in mapping:
 n=m['session'];p=next(p for p in projects if p['session']==n)
 j=json.loads((ROOT/p['projectId']/'project.json').read_text())
 assert j['settings']['fps']==dict(numerator=25,denominator=1)
 s=next(s for s in j['scenes'] if s['id']=='multicam-scene-1')
 assert j['currentSceneId']==s['id']
 tt=s['tracks'];tracks=tt['overlay']+[tt['main']]+tt['audio']
 media=json.loads((ROOT/p['projectId']/'media/index.json').read_text());byid={a['id']:a for a in media}
 assert len(media)==4
 audio=[t for t in tracks if t['type']=='audio'];assert len(audio)==2
 for route,camera in enumerate(['A1','Untitled'],1):
  t=next(t for t in tracks if t['name'].startswith('Routed '+str(route)))
  assert camera in t['name'] and t['muted']
  v=t['elements'][0];assert byid[v['mediaId']]['sourcePath']==m['cameras'][route-1]['path']
  a=next(t for t in audio if camera in t['name']);assert not a['muted'] and len(a['elements'])==1
  e=a['elements'][0];asset=byid[e['mediaId']]
  assert asset['name']==f'240504_{n:04}_{route}.wav'
  assert asset['sourcePath']==str(Path(copies['destination'])/asset['name'])
  params=e['params'];assert params['volume']==15 and params['gainDb']==-1
  assert params['hardLimiterEnabled'] and params['hardLimiterCeilingDb']==-1 and params['noiseReduction']==100
  off=(v['trimStart']-v['startTime']-e['trimStart']+e['startTime'])/120000
  assert abs(off-m['cameras'][route-1]['coarseOffset'])<.12,(n,camera,off)
 sharp=next(t for t in tracks if t['type']=='effect')['elements'][0]
 assert sharp['effectType']=='sharpen' and sharp['params']['intensity']==15
 end=sharp['duration'];visible=[]
 for t in tracks:
  for e in t['elements']:
   assert e['duration']>0 and e['startTime']>=0
   if e['type'] in ['audio','video']:
    assert e['trimStart']>=0 and e['trimEnd']>=0
    assert abs(e['trimStart']+e['duration']+e['trimEnd']-e['sourceDuration'])<=2
   if e['type']=='video':
    assert e['isSourceAudioEnabled'] is False
    if e.get('enabled',True) and not t.get('hidden',False):visible.append((e['startTime'],e['startTime']+e['duration']))
 visible.sort();assert visible[0][0]==0 and visible[-1][1]==end
 for a,b in zip(visible,visible[1:]):assert abs(a[1]-b[0])<=2,(n,a,b)
 assert len(visible)>20
 assert all(t['elements'][0]['startTime']+t['elements'][0]['duration']==end for t in audio)
 assert m['shortRecording']==(n==154)
 proof=json.loads((P/f'qa-{n:04}.json').read_text());assert proof['reopened'] and proof['advancedSeconds']>=2
 assert (P/f'session-{n:04}.png').stat().st_size>10000
 print(f'{n:04}: {end/120000:.2f}s, {len(visible)} shots; local audio, sync, finishing, ledger and playback passed')
inventory=json.loads((P/'inventory.json').read_text())
for item in inventory:
 if item['kind']!='camera':continue
 st=Path(item['path']).stat();assert (st.st_size,st.st_mtime_ns)==(item['size'],item['mtimeNs'])
precision=json.loads((P/'precision-evidence.json').read_text());assert len(precision)==16
for row in precision:
 assert sum(e['confidence']>.12 and abs(e['offsetSeconds'])<.04 for e in row['estimates'])>=2
print('All eight native podcasts passed. 24 local audio hashes verified; camera sources unchanged. No exports required.')
