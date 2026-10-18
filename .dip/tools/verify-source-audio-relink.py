import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
evidence=root/'analysis/source-audio-relink-2026-10-15'
baseline=json.loads((evidence/'baseline.json').read_text())
source=json.loads((evidence/'source-probe.json').read_text())
def digest(value):
 return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
stat=pathlib.Path(source['path']).stat()
assert stat.st_size==source['size'] and abs(stat.st_mtime*1000-source['lastModified'])<1
video=next(s for s in source['probe']['streams'] if s['codec_type']=='video')
assert video['r_frame_rate']=='25/1' and (video['width'],video['height'])==(3840,2160)
assert float(video['duration'])==6479.28
assert all(all(rms>0.00001 for rms in sample['channelRms']) for sample in json.loads((evidence/'source-audio-check.json').read_text()))
projects=[]
account=pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data')/baseline['account']/'projects'
for old in baseline['projects']:
 folder=account/old['id'];project=json.loads((folder/'project.json').read_text());assets=json.loads((folder/'media/index.json').read_text())
 assert digest(project['settings'])==old['settingsHash']
 assert digest(project.get('transcriptionJobs'))==old['transcriptionJobsHash']
 assert len(project['scenes'])==old['sceneCount']
 for before,scene in zip(old['scenes'],project['scenes']):
  assert before['id']==scene['id'] and digest(scene)==before['hash'],before['name']
 for before in old['assets']:
  if not before['references']:continue
  asset=next(a for a in assets if a['id']==before['id'])
  assert asset['sourcePath']==source['path'] and asset['size']==stat.st_size
  assert abs(asset['lastModified']-stat.st_mtime*1000)<1
  assert asset['bindingRevision']==before['bindingRevision']+1
  assert asset['bindingHistory'][-1]['size']==before['size']
  assert asset.get('missing') is False
 projects.append({'projectId':old['id'],'sceneCount':old['sceneCount']})
receipts=json.loads((evidence/'relink-receipts.json').read_text())
assert len(receipts)==3 and all(r['applied'] for r in receipts)
playback=json.loads((evidence/'playback-checks.json').read_text())
assert len(playback)>=3 and all(p['advanced'] and not p['muted'] and p['volume']>0 for p in playback)
assert (evidence/'delivery.png').stat().st_size>10000
print(json.dumps({'passed':True,'projects':projects,'preservedScenes':sum(x['sceneCount'] for x in projects),'source':source['path'],'sourceSeconds':6479.28}))
