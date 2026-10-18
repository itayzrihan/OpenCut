import subprocess, json, wave
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parent
SOURCE='/tmp/codex-remote-attachments/01a13d23-cc18-76f0-8e1a-cf3e55972277/2FDF740B-7745-4A23-8143-07691762B282/1-530c8b835d42449d9cb0742cd2a01ab3.mp4'
data=subprocess.check_output(['ffmpeg','-v','error','-i',SOURCE,'-vf','crop=720:220:0:300','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','-'])
frames=np.frombuffer(data,np.uint8).reshape(-1,220,720,3)
meta=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',SOURCE]))
times=[float(f['best_effort_timestamp_time']) for f in meta['frames']]
(ROOT/'frame-times.json').write_text(json.dumps(times))
for sheet in range(2):
 out=Image.new('RGB',(1440,12*250))
 dr=ImageDraw.Draw(out)
 for j in range(24):
  t=sheet*12+j*.5
  if t>23.6:continue
  idx=min(range(len(times)),key=lambda i:abs(times[i]-t))
  x=(j%2)*720;y=(j//2)*250
  out.paste(Image.fromarray(frames[idx]),(x,y+30));dr.text((x+5,y+5),f'{times[idx]:.3f}s / frame {idx}',fill='yellow')
 out.save(ROOT/f'timed-{sheet}.jpg')
with wave.open(str(ROOT/'source.wav')) as w:
 samples=np.frombuffer(w.readframes(w.getnframes()),np.int16).reshape(-1,w.getnchannels()).astype(float)/32768
 rate=w.getframerate()
out=Image.new('RGB',(1600,1200),'#101010');dr=ImageDraw.Draw(out)
for row in range(6):
 start=row*4
 dr.text((10,row*200+5),f'{start}–{start+4} s',fill='yellow')
 for px in range(1520):
  a=int((start+px/380)*rate);b=int((start+(px+1)/380)*rate)
  s=samples[a:b]
  if not s.size:continue
  peak=np.max(np.abs(s));x=60+px;y=row*200+100
  dr.line((x,y-int(peak*85),x,y+int(peak*85)),fill='white')
 for q in range(9):
  x=60+q*190;dr.line((x,row*200+25,x,row*200+185),fill='#444444');dr.text((x,row*200+185),str(start+q*.5),fill='yellow')
out.save(ROOT/'waveform.png')
print(len(frames),len(times))
