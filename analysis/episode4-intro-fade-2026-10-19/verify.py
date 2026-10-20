"""Verify the saved episode repair against the pre-edit local snapshot."""
import copy
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
before = json.loads((root / '.local/episode4-intro-fade-2026-10-19/before-project.json').read_text())
project = Path.home() / 'Movies/OpenCut Accounts/data/4fec0688-9a78-4304-849c-9ea937873751/projects/3bf1516d-a949-46a0-b631-39089691e736/project.json'
after = json.loads(project.read_text())
expected = copy.deepcopy(before['scenes'])
scene = next(s for s in expected if s['id'] == 'multicam-scene-2')
tracks = scene['tracks']
lior = next(t for t in tracks['overlay'] if t['id'] == 'multicam-track-655')
niva = next(t for t in tracks['overlay'] if t['id'] == 'multicam-track-882')
assert len(lior['elements']) == len(niva['elements']) == 179
for left, right in zip(lior['elements'], niva['elements']):
    assert left['startTime'] - right['startTime'] == 4776000
    assert left['duration'] == right['duration']
    assert left.get('enabled', True) != right.get('enabled', True)
    left['startTime'] = right['startTime']
assert after['scenes'] == expected, 'Unexpected change beyond Lior start times'
for field in ('settings', 'customFonts', 'version', 'currentSceneId'):
    assert after[field] == before[field], field
# Every output frame in the overlap, through the first cut after the intro,
# has exactly one active episode camera under the unchanged intro fade.
for tick in range(716000, 1020000, 4000):
    active = [e for t in (lior, niva) for e in t['elements']
              if e.get('enabled', True) and e['startTime'] <= tick < e['startTime'] + e['duration']]
    assert len(active) == 1, (tick, len(active))
print('PASS: all179 camera pairs aligned; all other scene data/settings exact; no uncovered overlap frames.')
