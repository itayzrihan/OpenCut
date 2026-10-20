from pathlib import Path
import subprocess,json,array
root=Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/9deb36b6-ef21-47bd-a830-9ad0ea784759')
p=json.loads((root/'project.json').read_text());s=next(s for s in p['scenes'] if s.get('multicam'))
assets={a['id']:a for a in json.loads((root/'media/index.json').read_text())}
def pcm(id,start):
 a=assets[id];path=a.get('sourcePath') or str(root/a['storedPath'])
 b=subprocess.check_output(['ffmpeg','-v','error','-ss',str(start),'-i',path,'-t','8','-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'])
 return list(array.array('f',b))
results=[]
for c in s['multicam']['channels']:
 for t in (300,900,1500):
  ref=pcm(c['videoId'],t+c.get('videoOffset',0)-c.get('videoDelay',0));tar=pcm(c['audioId'],t+c.get('audioOffset',0)-c.get('audioDelay',0))
  n=min(len(ref),len(tar));payload={'reference':ref[:n],'target':tar[:n],'sampleRate':16000}
  r=json.loads(subprocess.check_output(['target/debug/examples/precision_probe'],input=json.dumps(payload).encode()))
  r.update(channel=c['name'],time=t);results.append(r);print(json.dumps(r,ensure_ascii=False),flush=True)
Path('analysis/itay-yarden-podcast-2026-10-19/audio-check.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
