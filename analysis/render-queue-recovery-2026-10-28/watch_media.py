"""Check newly delivered outputs as they arrive; never edits project state."""
import json,pathlib,subprocess,sys,time
base=pathlib.Path(__file__).parent
checked=0
for _ in range(1080):
 try: count=len(json.loads((base/'delivered.json').read_text()))
 except (OSError,json.JSONDecodeError):time.sleep(10);continue
 if count>checked:
  subprocess.run([sys.executable,str(base/'check_media.py')],check=True)
  checked=count
 if checked==7:break
 time.sleep(10)
else:raise RuntimeError('Waiting for remaining completed exports')
