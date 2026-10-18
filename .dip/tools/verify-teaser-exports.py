import hashlib
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'analysis/teaser-exports-2026-10-14'
downloads = pathlib.Path('/Users/itayzrihan/Downloads')
baseline = json.loads((evidence / 'baseline.json').read_text())
project = json.loads(pathlib.Path('/Users/itayzrihan/Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/96fa8232-1976-427d-90eb-17cbf11c858c/project.json').read_text())

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

assert project['metadata']['id'] == baseline['projectId']
assert project['currentSceneId'] == baseline['currentSceneId']
assert digest(project['settings']) == baseline['settingsHash']
assert digest(project['transcriptionJobs']) == baseline['jobsHash']
assert len(project['scenes']) == len(baseline['scenes']) == 11
for before, after in zip(baseline['scenes'], project['scenes']):
    for key in ['id', 'name', 'isMain', 'createdAt']:
        assert before[key] == after[key], key
    assert before['tracksHash'] == digest(after['tracks']), after['name']
    assert before['bookmarksHash'] == digest(after['bookmarks'])

scene = next(s for s in project['scenes'] if s['id'] == '6125f350-cad1-4f95-b7b6-8cc507c24af7')
cues = sorted((e for t in scene['tracks']['overlay'] if t.get('captionSource') for e in t['elements']), key=lambda e: e['startTime'])
assert len(cues) == 69
assert all(not t.get('hidden') for t in scene['tracks']['overlay'])

def timestamp(tick):
    ms = round(tick / 120)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

expected = '\n\n'.join(f"{i}\n{timestamp(e['startTime'])} --> {timestamp(e['startTime']+e['duration'])}\n{e['params']['content']}" for i, e in enumerate(cues, 1)) + '\n'
assert (downloads / 'OpenCut-Teaser-FullAuto-2026-10-14.srt').read_text(encoding='utf-8-sig') == expected
assert all(0 <= c['startTime'] < c['startTime'] + c['duration'] <= 10507200 for c in cues)
assert all(a['startTime'] + a['duration'] <= b['startTime'] for a, b in zip(cues, cues[1:]))

outputs = []
audio = []
for variant in ['with', 'without']:
    path = downloads / f'OpenCut-Teaser-FullAuto-{variant}-captions-2026-10-14.mp4'
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate,duration,nb_read_frames', '-of', 'json', str(path)]))
    video, sound = probe['streams']
    assert video['codec_name'] == 'h264'
    assert (video['width'], video['height'], video['r_frame_rate']) == (1080, 1920, '25/1')
    assert int(video['nb_read_frames']) == 2189
    assert abs(float(video['duration']) - 87.56) < .001
    assert sound['codec_name'] == 'aac' and abs(float(sound['duration']) - 87.56) < .1
    pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-f', 'f32le', '-'])
    audio.append(hashlib.sha256(pcm).hexdigest())
    outputs.append({'path': str(path), 'probe': probe, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
assert audio[0] == audio[1]
source_check = json.loads((evidence / 'audio-source-check.json').read_text())
assert source_check['sourceSpeechCorrelation'] > .8
assert (evidence / 'with-captions.jpg').read_bytes() != (evidence / 'without-captions.jpg').read_bytes()
print(json.dumps({'passed': True, 'projectPreserved': True, 'captionCues': len(cues), 'decodedAudioIdentical': True, 'sourceSpeechCorrelation': source_check['sourceSpeechCorrelation'], 'outputs': outputs}, ensure_ascii=False))
