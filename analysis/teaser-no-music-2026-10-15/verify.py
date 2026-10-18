import json,pathlib,hashlib,subprocess
ev=pathlib.Path(__file__).parent
root=ev.parents[1]
before=json.loads((root/'.local/teaser-no-music-2026-10-15/project-before.json').read_text())
after=json.loads(pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/96fa8232-1976-427d-90eb-17cbf11c858c/project.json').read_text())
assert before['scenes']==after['scenes']
assert before['settings']==after['settings'] and before.get('transcriptionJobs')==after.get('transcriptionJobs')
state=json.loads((ev/'export-track-state.json').read_text())
assert len(state['captions'])==2 and all(c['hidden'] for c in state['captions'])
assert state['mainMuted'] is False
assert [a['muted'] for a in state['audio']]==[False,False,True]
manifest=json.loads((ev/'manifest.json').read_text());p=pathlib.Path(manifest['path'])
assert hashlib.sha256(p.read_bytes()).hexdigest()==manifest['sha256']
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_entries','stream=codec_name,width,height,r_frame_rate,duration,nb_read_frames,bit_rate','-of','json',str(p)]))['streams']
assert (probe[0]['codec_name'],probe[0]['width'],probe[0]['height'],probe[0]['r_frame_rate'])==('h264',1080,1920,'25/1')
assert int(probe[0]['nb_read_frames'])==2093 and float(probe[0]['duration'])==83.72
assert int(probe[0]['bit_rate'])>11000000
assert 'radio button Very high - Largest file size, Value: 1' in (ev/'quality-very-high.txt').read_text()
assert probe[1]['codec_name']=='aac' and abs(float(probe[1]['duration'])-83.72)<.1
audio=json.loads((ev/'audio-check.json').read_text())
assert audio['sourceSpeechCorrelation']>.99 and audio['differsFromMusicMix']
ui=(ev/'uploaded-state.txt').read_text()
assert manifest['name'] in ui and ('Upload complete' in ui or '1 upload complete' in ui)
assert 'Uploading 1 item' not in ui and 'Cancel upload' not in ui
assert manifest['driveFileId'] in (ev/'drive-item.json').read_text()
assert (ev/'uploaded.png').stat().st_size>10000 and (ev/'no-captions.jpg').stat().st_size>10000
print(json.dumps({'passed':True,'videoSeconds':83.72,'frames':2093,'musicMuted':True,'captionsHidden':True,'projectRestored':True,'uploaded':manifest['url']}))
