"""Check actual published files, frame provenance, retained catalog, and decoded durations."""
import hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
library=Path.home()/'Movies/OpenCut Accounts/global/shared-library'
before=json.loads((ROOT/'global-manifest-before.json').read_text())['audioAssets']
after=json.loads((library/'manifest.json').read_text())['audioAssets']
records={a['id']:a for a in after}
assert len(records)==len(after)
for a in before:assert records[a['id']]==a, a['id']
frames=json.loads((ROOT/'frame-times.json').read_text());ranges=json.loads((ROOT/'ranges.json').read_text())['effects']
assets=json.loads((ROOT/'catalog.json').read_text())['audioAssets'];evidence=[]
for a,r in zip(assets,ranges):
 actual=records[a['id']];file=library/'audio/sfx'/a['fileName']
 assert actual['visibility']=='global' and actual['folder']=='sfx'
 assert actual['name']==r['name'] and actual['duration']==round(r['end']-r['start'],6)
 assert actual['sourceUrl']==f"/api/global-assets/shared-library/audio/sfx/{file.name}"
 assert hashlib.sha256(file.read_bytes()).hexdigest()==a['sha256']==actual['sha256']==r['sha256']
 assert frames[r['startFrame']]==r['start'] and frames[r['endFrameExclusive']]==r['end']
 probe=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_streams','-of','json',str(file)]))['streams'][0]
 assert probe['codec_name']=='mp3' and probe['channels']==2 and probe['sample_rate']=='44100'
 decoded=subprocess.check_output(['ffmpeg','-v','error','-i',str(file),'-f','s16le','-'])
 samples=len(decoded)//4
 # libmp3lame gapless sample counts can differ by <1ms for short frames.
 assert abs(samples/44100-a['duration'])<.001
 assert max(decoded)>0
 evidence.append({'name':a['name'],'duration':a['duration'],'sha256':a['sha256'],'decodedSamples':samples})
result={'verified':len(evidence),'previousAssetsUnchanged':len(before),'globalAssetCount':len(after),'files':evidence}
(ROOT/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
