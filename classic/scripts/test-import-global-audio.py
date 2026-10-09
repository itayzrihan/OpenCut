import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('global_audio_import', Path(__file__).with_name('import-global-audio.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class GlobalAudioImportTests(unittest.TestCase):
    def test_original_id_bytes_and_review_survive_repeated_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = '11111111-1111-4111-8111-111111111111'
            private = root / 'data' / owner / 'shared-library'
            private.mkdir(parents=True)
            legacy = root / 'legacy'
            (legacy / 'files' / 'audio').mkdir(parents=True)
            original = legacy / 'files' / 'audio' / 'swish'
            original.write_bytes(b'original audio')
            (private / 'manifest.json').write_text(json.dumps({'audioAssets': [{'id': 'swish', 'fileName': 'swish.mp3', 'folder': 'sfx', 'size': 14}]}))
            prepared = module.prepare(root, None, owner, legacy)
            self.assertEqual(module.publish(root, prepared), 1)
            manifest = root / 'global' / 'shared-library' / 'manifest.json'
            data = json.loads(manifest.read_text())
            self.assertEqual(data['audioAssets'][0]['license']['status'], 'needs-review')
            self.assertEqual(data['audioAssets'][0]['id'], 'swish')
            data['audioAssets'][0]['license']['note'] = 'Reviewed by owner later'
            manifest.write_text(json.dumps(data))
            self.assertEqual(module.publish(root, prepared), 1)
            self.assertEqual(json.loads(manifest.read_text())['audioAssets'][0]['license']['note'], 'Reviewed by owner later')
            self.assertEqual(original.read_bytes(), b'original audio')
            original.write_bytes(b'different file')
            changed = module.prepare(root, None, owner, legacy)
            with self.assertRaisesRegex(ValueError, 'different bytes'):
                module.publish(root, changed)
            self.assertEqual((manifest.parent / 'audio' / 'sfx' / 'swish.mp3').read_bytes(), b'original audio')

    def test_bad_checksum_and_missing_file_never_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'music.mp3'
            file.write_bytes(b'audio')
            item = {'id': 'music', 'folder': 'music', 'fileName': 'music.mp3', 'size': 5, 'sourceFile': str(file), 'sha256': 'wrong', 'license': {'status': 'needs-review'}}
            catalog = root / 'catalog.json'
            catalog.write_text(json.dumps({'audioAssets': [item]}))
            with self.assertRaisesRegex(ValueError, 'Checksum'):
                module.prepare(root, catalog, None)
            file.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing'):
                module.prepare(root, catalog, None)
            self.assertFalse((root / 'global').exists())

if __name__ == '__main__':
    unittest.main()
