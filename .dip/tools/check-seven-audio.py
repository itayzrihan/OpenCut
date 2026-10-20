# Signal check on the actual bound sources used by each saved output.
# Does not export media, alter any scene, or establish a human listening verdict.
import json,pathlib,subprocess,re,math
root=pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/9deb36b6-ef21-47bd-a830-9ad0ea784759')
p=json.load(open(root/'project.json'));m={x['id']:x for x in json.load(open(root/'media/index.json'))}
evidence=json.load(open('analysis/seven-smart-2026-10-20/outputs.json'));outputs=[]
for item in evidence['outputs']:
 s=next(s for s in p['scenes']if s['id']==item['sceneId']);routes=[]
 for t in s['tracks']['audio']:
  if t.get('muted'):continue
  clips=sorted((e for e in t['elements']if e.get('enabled')is not False and not e.get('params',{}).get('muted')),key=lambda e:e['startTime'])
  if not clips:continue
  e=next((x for x in clips if x['duration']>=3*120000),clips[0]);asset=m[e['mediaId']]
  paths=[pathlib.Path(asset['sourcePath'])]if asset.get('sourcePath')else list((root/'media/files').glob(e['mediaId']+'--*'))
  assert len(paths)==1 and paths[0].is_file()
  rate=e.get('retime',{}).get('rate',1);offset=e.get('params',{}).get('audioSyncOffset',0)
  start=max(0,e.get('trimStart',0)/120000-offset*rate);duration=min(8,e['duration']/120000)*rate
  result=subprocess.run(['ffmpeg','-nostdin','-hide_banner','-ss',str(start),'-t',str(duration),'-i',str(paths[0]),'-vn','-sn','-af','volumedetect','-f','null','-'],stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=30)
  assert result.returncode==0,result.stderr[-500:]
  mean=re.search(r'mean_volume:\s*([\-\w.]+) dB',result.stderr);peak=re.search(r'max_volume:\s*([\-\w.]+) dB',result.stderr);assert mean and peak
  db=float(mean.group(1));assert math.isfinite(db)
  routes.append({'mediaId':e['mediaId'],'gainDb':e.get('params',{}).get('volume',0),'sampleSeconds':round(duration,3),'sourceMeanDb':db,'sourcePeakDb':float(peak.group(1))})
 assert routes and max(x['sourceMeanDb']for x in routes)>-60, 'No decoded speech signal in saved output'
 outputs.append({'sceneId':s['id'],'routes':routes,'decodedSignalPresent':True})
result={'passed':True,'outputs':outputs,'scope':'Representative decoded source audio plus saved unmuted routes; no export or human listening verdict.'}
json.dump(result,open('analysis/seven-smart-2026-10-20/audio-verification.json','w'),indent=2,ensure_ascii=False);print(json.dumps(result,ensure_ascii=False))
