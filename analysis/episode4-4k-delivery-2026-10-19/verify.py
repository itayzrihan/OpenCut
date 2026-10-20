import json, subprocess
from pathlib import Path
p=Path('/Volumes/Portable Sandisk SSD/לקוחות/Lior Niva New/פרק 4 — המציאות לא זזה — 4K HEVC.mp4')
m=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]))
v=next(s for s in m['streams'] if s['codec_type']=='video')
assert (v['codec_name'],v['width'],v['height'])==('hevc',3840,2160)
assert any(s['codec_type']=='audio' for s in m['streams'])
assert abs(float(m['format']['duration'])-1748.810884)<0.1
assert p.stat().st_size==7074720912
receipt=Path('analysis/episode4-4k-delivery-2026-10-19/drive-upload-receipt.txt').read_text()
assert '2 uploads complete' in receipt and 'Uploading 1 item' not in receipt
assert 'gridcell "'+p.name+' Video More info' in receipt
assert 'Niva-Lior' in receipt and 'SE02 EP01' in receipt
print('HEVC 4K, audio, complete duration and exact size verified locally; captured Drive UI confirms completed upload and folder listing. User performed upload; no duplicate uploaded by agent.')
