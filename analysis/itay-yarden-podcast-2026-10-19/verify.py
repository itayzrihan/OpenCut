from pathlib import Path
import json,hashlib
base=Path(__file__).resolve().parent
root=Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects')
p=root/'9deb36b6-ef21-47bd-a830-9ad0ea784759/project.json'
d=json.loads(p.read_text());before=json.loads((base/'before.json').read_text())
for old in before['scenes']:
 assert old==next(s for s in d['scenes'] if s['id']==old['id']),'Original scene changed'
s=next(s for s in d['scenes'] if s.get('multicam'));m=s['multicam'];duration=round(m['duration']*120000)
tracks=[*s['tracks']['overlay'],s['tracks']['main'],*s['tracks']['audio']]
v=[t for t in tracks if t['type']=='video' and t['elements']];a=[t for t in tracks if t['type']=='audio']
assert len(v)==2 and len(a)==2
assert len(m['cuts'])==232 and 1900<m['duration']<2000
assert m['settings']['minCutDuration']==1 and m['settings']['maxCutDuration']==20
assert m['settings']['keepCameraMics']==False
for c,t in zip(m['channels'],v):
 assert t['muted'] is True
 for e in t['elements']:
  assert e['mediaId']==c['videoId'] and e['isSourceAudioEnabled'] is False
  assert abs((e['trimStart']-e['startTime'])/120000-(c.get('videoOffset',0)-c.get('videoDelay',0)))<1/120000
for cut in m['cuts']:
 time=(cut['timestamp']+cut['duration']/2)*120000
 active=[e for t in v for e in t['elements'] if e.get('enabled',True) and e['startTime']<=time<e['startTime']+e['duration']]
 assert len(active)==1,'Camera coverage gap/overlap'
 c=next(c for c in m['channels'] if c['id']==cut['channelId']);assert active[0]['mediaId']==c['videoId']
for c,t in zip(m['channels'],a):
 assert len(t['elements'])==1 and not t.get('muted',False)
 e=t['elements'][0];assert e['mediaId']==c['audioId'] and e['name'].lower().endswith('.wav')
 for k,value in {'volume':15,'gainDb':-1,'noiseReduction':100,'hardLimiterEnabled':True,'hardLimiterCeilingDb':-1}.items():assert e['params'][k]==value
 assert abs((e['trimStart']-e['startTime'])/120000-(c.get('audioOffset',0)-c.get('audioDelay',0)))<1/120000
fx=[e for t in tracks for e in t['elements'] if e.get('effectType')=='sharpen'];assert len(fx)==1 and fx[0]['params']['intensity']==15 and fx[0]['duration']>=duration
results=json.loads((base/'audio-check.json').read_text());accepted=[r for r in results if r['confidence']>=.12]
for c in m['channels']:
 valid=[r for r in accepted if r['channel']==c['name']];assert len(valid)>=2
 assert all(abs(r['offsetSeconds'])<.015 for r in valid)
ep4=root/'3bf1516d-a949-46a0-b631-39089691e736/project.json'
assert hashlib.sha256(ep4.read_bytes()).hexdigest()==(base/'episode4-before.sha256').read_text().strip()
report={'projectId':d['metadata']['id'],'sceneId':s['id'],'sceneName':s['name'],'durationSeconds':m['duration'],'cameraSegments':len(m['cuts']),'cameraTracks':len(v),'microphoneTracks':len(a),'audioAcceptedWindows':len(accepted),'audioRejectedWindows':len(results)-len(accepted),'maxMeasuredResidualMs':max(abs(r['offsetSeconds']) for r in accepted)*1000,'episode4Unchanged':True,'originalSceneUnchanged':True,'projectSha256':hashlib.sha256(p.read_bytes()).hexdigest()}
(base/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
