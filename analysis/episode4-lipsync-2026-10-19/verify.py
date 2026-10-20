"""Verify saved mic sync and bounded acoustic measurement evidence."""
import copy
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
local = root / '.local/episode4-lipsync-2026-10-19'
project = Path.home() / 'Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/3bf1516d-a949-46a0-b631-39089691e736/project.json'
before = json.loads((local / 'before-project.json').read_text())
after = json.loads(project.read_text())
expected = copy.deepcopy(before['scenes'])
scene = next(s for s in expected if s['id'] == 'multicam-scene-2')
count = 0
for track in scene['tracks']['audio']:
    if track['id'] in ('multicam-track-656', 'multicam-track-883'):
        assert len(track['elements']) == 1
        track['elements'][0]['params']['audioSyncOffset'] = 20800 / 120000
        count += 1
assert count == 2
assert after['scenes'] == expected, 'Unexpected scene edit beyond two audio sync offsets'
for key in ('settings', 'customFonts', 'version', 'currentSceneId'):
    assert after[key] == before[key], key
measurements = json.loads((local / 'after-measurements.json').read_text())
original = json.loads((local / 'measurements.json').read_text())
assert len(measurements) == len(original) == 6
for old, new in zip(original, measurements):
    assert old['camera'] == new['camera'] and old['timelineSeconds'] == new['timelineSeconds']
    assert abs(new['delayCorrectionSeconds']) < 0.040, new
    assert abs(new['delayCorrectionSeconds']) < abs(old['delayCorrectionSeconds']), new
    assert abs(old['delayCorrectionSeconds'] - new['delayCorrectionSeconds'] - 20800/120000) < 0.001
print('PASS: only two microphone sync offsets changed (+173.333ms); cuts, effects, intro and settings exact.')
print('PASS: six source-audio comparisons improved at 55s,600s,1800s; residuals within40ms.')
