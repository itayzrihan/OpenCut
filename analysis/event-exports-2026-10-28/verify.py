import hashlib,json,pathlib,subprocess
root=pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751')
rows=json.loads(pathlib.Path(__file__).with_name('manifest.json').read_text())
queue=json.loads((root/'render-queue/runtime.json').read_text())['active']['document']['renderQueue']
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
assert len(rows)==4
results=[]
for row in rows:
 job=next(j for j in queue if j['id']==row['jobId'])
 assert job['status']=='completed',(row['name'],job['status'],job['message'])
 assert job['sourceRevision']==row['sourceRevision']
 assert digest(job['snapshot']['document'])==row['snapshotSha256']
 saved=json.loads(json.loads((root/'projects'/row['projectId']/'project.json').read_text())['__opencutEditorSession'])['saved']
 assert saved['editorRevision']>=row['sourceRevision']
 if saved['editorRevision']==row['sourceRevision']:assert digest(saved['project'])==row['snapshotSha256']
 path=pathlib.Path(row['path']);assert path.stat().st_size>1000000
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
 video=next(s for s in probe['streams'] if s['codec_type']=='video');audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
 assert video['codec_name']=='h264'
 assert (video['width'],video['height'])==(3840,2160)
 assert audio['codec_name']=='aac'
 assert abs(float(probe['format']['duration'])-row['seconds'])<.2
 # Decode actual video/audio packets at the beginning, middle and end.
 for at in [0,row['seconds']/2,row['seconds']-1]:
  subprocess.run(['ffmpeg','-v','error','-ss',str(at),'-i',str(path),'-t','0.3','-map','0:v:0','-map','0:a:0','-f','null','-'],check=True,stdout=subprocess.DEVNULL)
 results.append(dict(name=row['name'],path=str(path),bytes=path.stat().st_size,seconds=float(probe['format']['duration']),video=video['codec_name'],audio=audio['codec_name'],width=video['width'],height=video['height'],sourceRevision=row['sourceRevision']))
print(json.dumps(results,ensure_ascii=False,indent=2))
print('Four trimmed native OpenCut exports verified: frozen saved revisions, H264/AAC 3840x2160, matching durations and decoded start/middle/end packets.')
