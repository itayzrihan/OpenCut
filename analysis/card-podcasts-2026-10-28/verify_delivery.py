"""Verify native saved podcast documents, evidence receipts and read-only source guards."""
import hashlib,json,math
from pathlib import Path
P=Path(__file__).resolve().parent;T=120000
receipts=json.loads((P/'editor-receipts.json').read_text());mapping=json.loads((P/'verified-mapping.json').read_text());playback=json.loads((P/'playback-evidence.json').read_text())
for row in mapping:
 n=f"{row['session']:04}";j=json.loads((P/f'project-{n}-final.json').read_text());reopened=json.loads((P/f'project-{n}-reopened.json').read_text());assert j==reopened,f'{n}: save/reopen mismatch'
 r=receipts[n];state=r['app.get_state']['output'];assert state['project']['id']==r['projectId'] and state['project']['dirty'] is False
 assert state['export']['status']=='idle' and not state['export']['downloadReady'];assert not state['diagnostics']
 assert j['projectSettings']['fps']==dict(denominator=1,numerator=25)
 digest=hashlib.sha256(json.dumps(j,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest();assert 'sha256:'+digest==r['timeline.read_full_source']['baseRevision']
 media=r['timeline.list_media']['output']['mediaAssets'];assert len(media)==4;byid={a['id']:a for a in media};assert sum(a['type']=='video' for a in media)==2
 audios=[a for a in media if a['type']=='audio'];assert sorted(a['name'] for a in audios)==[f'240504_{n}_1.wav',f'240504_{n}_2.wav']
 tracks=j['scene']['tracks'];aud=[t for t in tracks if t['type']=='audio'];assert len(aud)==2
 for mic,camera in [(2,'A3'),(1,'A4')]:
  track=next(t for t in aud if camera in t['name']);assert not track['muted'];assert len(track['elements'])==1;e=track['elements'][0];assert byid[e['mediaId']]['name']==f'240504_{n}_{mic}.wav';p=e['params'];assert p['volume']==15 and p['gainDb']==-1 and p['hardLimiterEnabled'] and p['hardLimiterCeilingDb']==-1 and p['noiseReduction']==100 and e['podcastFinishingVersion']==1
 sharp=next(t for t in tracks if t['type']=='effect')['elements'][0];assert sharp['effectType']=='sharpen' and sharp['params']['intensity']==15
 end=sharp['duration'];visible=[]
 for track in tracks:
  for e in track['elements']:
   assert e['duration']>0 and e['startTime']>=0
   if e['type'] in ['video','audio']:
    assert e['trimStart']>=0 and e['trimEnd']>=0
    assert abs(e['trimStart']+e['duration']+e['trimEnd']-e['sourceDuration'])<=2
    assert e['mediaId'] in byid
   if e['type']=='video':
    assert e['isSourceAudioEnabled'] is False
    if e.get('enabled',True) and not track['hidden']:visible.append((e['startTime'],e['startTime']+e['duration']))
 visible.sort();assert visible[0][0]==0 and visible[-1][1]==end
 for a,b in zip(visible,visible[1:]):assert abs(a[1]-b[0])<=2,(n,'video hole or overlap',a,b)
 assert len(visible)>30
 assert all(t['elements'][0]['startTime']+t['elements'][0]['duration']==end for t in aud)
 assert playback[n]['advancedSeconds']>=2 and playback[n]['reopened'] is True
 assert (P/f'preview-{n}.png').stat().st_size>10000
 print(f'{n}: saved/reopened {end/T:.2f}s, {len(visible)} visible shots, correct mic routing and finishing, playback passed')
items=json.loads((P/'inventory.json').read_text());selected=[x for x in items if x['kind']=='camera' or any(f'_{n}_' in x['path'] for n in ['0157','0158','0159','0160'])];assert len(selected)==16
for x in selected:
 s=Path(x['path']).stat();assert (s.st_size,s.st_mtime_ns)==(x['bytes'],x['mtimeNs']),x['path']
precision=json.loads((P/'precision-evidence.json').read_text());assert len(precision)==8
for row in precision:assert sum(e['confidence']>.12 and abs(e['offsetSeconds'])<.04 for e in row['estimates'])>=2
assert len(json.loads((P/'speech-moments.json').read_text()))==4
print('All four native regular podcasts verified; all16 source files unchanged; no exports.')
