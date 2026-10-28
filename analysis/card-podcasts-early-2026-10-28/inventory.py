import concurrent.futures,json,pathlib,subprocess,re
out=pathlib.Path(__file__).parent
paths=[p for volume in ['A1','Untitled'] for p in sorted(pathlib.Path('/Volumes',volume,'PRIVATE/M4ROOT/CLIP').glob('*.MP4'))]
paths += [p for p in sorted(pathlib.Path('/Volumes/MicroSD/SOUND').glob('*.wav')) if re.search(r'_0(148|149|15[0-6])_[12]\.wav$',p.name)]
def probe(p):
 s=p.stat();d=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]));return dict(path=str(p),kind='camera' if p.suffix=='.MP4' else 'microphone',size=s.st_size,mtimeNs=s.st_mtime_ns,probe=d)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:items=list(pool.map(probe,paths))
(out/'inventory.json').write_text(json.dumps(items,ensure_ascii=False,indent=2))
for x in items:print(x['path'],x['probe']['format']['duration'],[(s['codec_type'],s.get('width'),s.get('height'),s.get('sample_rate')) for s in x['probe']['streams']])
