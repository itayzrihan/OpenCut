import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
folder = root / 'analysis/teaser-drive-2026-10-14'
manifest = json.loads((folder / 'manifest.json').read_text())
ui = (folder / 'uploaded-state.txt').read_text()
assert manifest['folderUrl'] in ui
assert '4 uploads complete' in ui
assert len(manifest['files']) == 4
for file in manifest['files']:
    path = pathlib.Path(file['path'])
    assert path.name in ui
    assert path.stat().st_size == file['size']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == file['sha256']
assert (folder / 'uploaded.png').stat().st_size > 10000
print(json.dumps({'passed': True, 'verifiedBy': 'Drive visible completion and four filenames; local upload source hashes', 'folderUrl': manifest['folderUrl'], 'files': [x['name'] for x in manifest['files']]}))
