"""Local Premiere XML benchmark extraction; requires ffmpeg and numpy.
Select original video tracks and their microphone tracks in matching camera order.
Selected tracks must contain straight cuts (no nested sequences, transitions or retiming).
This writes only a regression fixture and RMS envelopes, never changes source media.
"""
import argparse, hashlib, json, pathlib, subprocess, urllib.parse, xml.etree.ElementTree as ET
import numpy as np

def envelope(path, destination):
    signature = {'path':str(path),'size':path.stat().st_size,'mtimeNs':path.stat().st_mtime_ns,'sampleRate':48000,'windowSeconds':.01}
    stamp=destination.with_suffix('.source.json')
    if destination.exists() and stamp.exists() and json.loads(stamp.read_text())==signature: return np.load(destination)
    proc=subprocess.Popen(['ffmpeg','-v','error','-i',str(path),'-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],stdout=subprocess.PIPE)
    parts=[];pending=b''
    try:
        while chunk:=proc.stdout.read(1920000):
            pending+=chunk;usable=len(pending)//1920*1920
            samples=np.frombuffer(pending[:usable],dtype='<f4').reshape(-1,480)
            parts.append(np.sqrt(np.mean(samples*samples,axis=1)));pending=pending[usable:]
        if proc.wait(): raise RuntimeError(f'ffmpeg failed: {path}')
    finally:
        if proc.poll() is None: proc.kill();proc.wait()
        proc.stdout.close()
    if pending:
        last=np.frombuffer(pending,dtype='<f4');parts.append(np.array([np.sqrt(np.mean(last*last))]))
    result=np.concatenate(parts);np.save(destination,result);stamp.write_text(json.dumps(signature,indent=2));return result

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('xml',type=pathlib.Path);p.add_argument('--sequence',required=True);p.add_argument('--video-tracks',type=int,nargs='+',required=True);p.add_argument('--audio-tracks',type=int,nargs='+',required=True);p.add_argument('--output',type=pathlib.Path,required=True);args=p.parse_args()
    if len(args.video_tracks)!=len(args.audio_tracks):p.error('One external microphone track per camera is required')
    root=ET.parse(args.xml).getroot();seqs=[s for s in root.findall('.//sequence') if s.findtext('name')==args.sequence]
    if len(seqs)!=1:raise ValueError('Sequence must resolve unambiguously')
    s=seqs[0];fps=int(s.findtext('rate/timebase'))*(1000/1001 if s.findtext('rate/ntsc')=='TRUE' else 1)
    files={f.get('id'):pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(f.findtext('pathurl')).path)) for f in root.findall('.//file') if f.findtext('pathurl')}
    tracks={}
    for kind,selected in [('video',args.video_tracks),('audio',args.audio_tracks)]:
        source=s.findall('media/'+kind+'/track')
        for number,index in enumerate(selected):
            t=source[index];clips=[]
            for c in t.findall('clipitem'):
                if c.find('file') is None or c.find('file').get('id') not in files:raise ValueError('Select original media tracks, not nested sequences')
                clip={key:int(c.findtext(key)) for key in ['start','end','in']}
                if clip['start']<0 or clip['end']<=clip['start']:raise ValueError('Selected tracks contain a transition or invalid interval')
                if int(c.findtext('out'))-clip['in']!=clip['end']-clip['start']:raise ValueError('Retimed clips require an explicit source clock mapping')
                clip.update(path=str(files[c.find('file').get('id')]),enabled=c.findtext('enabled','TRUE')=='TRUE' and t.findtext('enabled','TRUE')=='TRUE');clips.append(clip)
            if not clips:raise ValueError('Empty source track')
            tracks[kind+str(number)]=clips
    origin=max(min(c['start'] for c in tracks['video'+str(i)]) for i in range(len(args.video_tracks)))
    end=min(max(c['end'] for c in tracks['video'+str(i)]) for i in range(len(args.video_tracks)))
    labels=np.full(end-origin,-1)
    for number in sorted(range(len(args.video_tracks)),key=lambda n:args.video_tracks[n]):
        for c in tracks['video'+str(number)]:
            lo=max(origin,c['start']);hi=min(end,c['end'])
            if c['enabled'] and hi>lo:labels[lo-origin:hi-origin]=number
    if np.any(labels<0):raise ValueError('Reference contains uncovered camera frames')
    breaks=np.r_[0,np.flatnonzero(np.diff(labels))+1,len(labels)]
    ids=['camera-'+str(i+1) for i in range(len(args.video_tracks))]
    reference=[dict(timestamp=int(a)/fps,duration=int(b-a)/fps,channelId=ids[int(labels[a])]) for a,b in zip(breaks[:-1],breaks[1:])]
    out=args.output;out.mkdir(parents=True,exist_ok=True);(out/'reference-cuts.json').write_text(json.dumps(reference,indent=2))
    aligned=[];duration=(end-origin)/fps;count=int(np.ceil(duration*100))
    for kind in ['video','audio']:
        for i in range(len(ids)):
            clips=tracks[kind+str(i)];paths={c['path'] for c in clips}
            if len(paths)!=1:raise ValueError('Multiple files on a selected track require separate fixtures')
            raw=envelope(pathlib.Path(clips[0]['path']),out/(kind+str(i)+'-full.npy'))
            if kind=='audio':
                a=np.zeros(count,dtype=np.float32)
                for c in clips:
                    if not c['enabled']:continue
                    lo=max(origin,c['start']);hi=min(end,c['end'])
                    if lo>=hi:continue
                    dest=round((lo-origin)/fps*100);src=round((c['in']+lo-c['start'])/fps*100);length=round((hi-lo)/fps*100)
                    usable=min(length,count-dest,len(raw)-src)
                    if usable<=0:raise ValueError('Source audio does not cover the reference')
                    a[dest:dest+usable]=raw[src:src+usable]
                aligned.append(a.tolist())
    settings=dict(sequenceName='Benchmark',minCutDuration=1,maxCutDuration=20,reactionDuration=5,preRoll=.15,maxLagSeconds=1200,crosstalkBehavior='stay',silenceBehavior='stay_on_last',antiBleed=True,keepCameraMics=False)
    (out/'analyze-input.json').write_text(json.dumps(dict(envelopes=aligned,channelIds=ids,duration=duration,settings=settings)))
    (out/'manifest.json').write_text(json.dumps(dict(sequence=args.sequence,fps=fps,originFrame=origin,endFrame=end,xmlSha256=hashlib.sha256(args.xml.read_bytes()).hexdigest(),tracks=tracks),indent=2))
    print(json.dumps(dict(frames=len(labels),fps=fps,transitions=len(reference)-1,output=str(out)),indent=2))
if __name__=='__main__':main()
