"""Verify recovered frozen exports and real detached-worker evidence."""
import json, pathlib, subprocess, hashlib, re
base=pathlib.Path(__file__).parent
baseline=json.loads((base/'jobs-before.json').read_text())
root=pathlib.Path.home()/'Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/render-queue'
jobs={j['id']:j for j in json.loads((root/'runtime.json').read_text())['active']['document']['renderQueue']}
delivered={j['jobId']:j for j in json.loads((base/'delivered.json').read_text())}
assert len(baseline)==len(delivered)==7
assert all(re.fullmatch(r'[0-9a-f]{64}',d['sha256']) for d in delivered.values())
assert (base/'completed-queue-view.txt').read_text().count('\nCompleted\n')==7
assert (base/'completed-queue.png').stat().st_size>0
for before in baseline:
 job=jobs[before['id']]
 for field in ('projectId','sceneId','sourceRevision','snapshotHash','options'):
  assert job[field]==before[field],(before['id'],field)
 assert job['status']=='completed',before['projectName']
 assert job.get('outputId'),before['projectName']
 receipt=delivered[job['id']]
 path=pathlib.Path(receipt['path'])
 assert path.stat().st_size==receipt['size']>100000
 assert receipt['snapshotHash']==job['snapshotHash']
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
 video=next(s for s in probe['streams'] if s['codec_type']=='video')
 audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
 assert video['codec_name']=='hevc' and audio['codec_name']=='aac'
 assert (video['width'],video['height'],video['avg_frame_rate'])==(3840,2160,'25/1')
 scene=next(s for s in job['snapshot']['document']['scenes'] if s['id']==job['sceneId'])
 tracks=scene['tracks']; elements=[e for t in [tracks['main'],*tracks['overlay'],*tracks['audio']] for e in t['elements']]
 expected=max(e['startTime']+e['duration'] for e in elements)/120000
 assert abs(float(probe['format']['duration'])-expected)<.2,(before['projectName'],expected,probe['format']['duration'])
 assert (root/job['id']/'output.mp4').resolve()==path.resolve()
 print('Verified export:',before['projectName'],flush=True)
checks=json.loads((base/'media-checks.json').read_text())
assert {c['jobId'] for c in checks if c['decodedStartMiddleEnd']}==set(delivered)
projectRoot=root.parent/'projects'
for guard in json.loads((base/'project-guards.json').read_text()):
 folder=projectRoot/guard['projectId'];doc=json.loads((folder/'project.json').read_text());payload={k:doc.get(k) for k in ['scenes','settings','currentSceneId','customFonts']}
 assert hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()==guard['editsSha256'],'User edits must remain unchanged'
 assert hashlib.sha256((folder/'media/index.json').read_bytes()).hexdigest()==guard['mediaSha256']
fixture=json.loads((base/'background-fixture.json').read_text())
assert fixture['passed'] and fixture['noQueueWindowOpened'] and fixture['workerExitedIdle']
assert len(fixture['outputs'])==2
assert fixture['normalAuthenticatedHostLaunch'] and fixture['concurrentViewerRequests']
ui=json.loads((base/'live-ui.json').read_text())
assert ui['sharedDialog'] and ui['noAdditionalTabs'] and ui['progressAfterClosingView']
assert ui['release']==fixture['release']
assert ui['continuedUpdatedAtMs']>ui['queueClosedAtMs']
assert 0<ui['continuedProgress']<1
assert ui['editorPlaybackDuringBackground']
assert ui['sameTabIds'] and ui['reopenedDuringActiveRender'] and ui['workerReusedDuringActiveView']
assert ui['secondContinuedAtMs']>ui['secondClosedAtMs']
assert ui['secondContinuedProgress']>ui['secondInitialProgress']
deploy=json.loads((base/'deployment.json').read_text())
log=(pathlib.Path.home()/'Library/Application Support/OpenCut Local/logs/production.log').read_bytes()[deploy['productionLogOffset']:]
assert b'updateTimeout' not in log
regression=json.loads((base/'regression/summary.json').read_text())
assert regression['passed']==16 and regression['failedSuites']==0 and regression['failed']==0

release=json.loads((pathlib.Path.home()/"Library/Application Support/OpenCut Local/current.json").read_text())
assert release['id']==ui['release']
files=sorted(p for p in subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard']).decode().split('\0') if p)
hash=hashlib.sha256()
for file in files:
 if file.endswith('/next-env.d.ts'):continue
 if not re.match(r'^(classic/(apps/(web|electron/app)|rust|packages|patches)/|crates/|resources/|Cargo\.(toml|lock)$|classic/(package\.json|bun\.lock)$)',file):continue
 hash.update(file.encode())
 path=pathlib.Path(file);hash.update(path.read_bytes() if path.exists() else b'deleted')
assert hash.hexdigest()==release['fingerprint'],'Deployed release must match current canonical product source'
print('PASS: seven original frozen 4K HEVC/AAC snapshots delivered, detached renderer, shared closable queue and deployed source verified.')
