"""Classify reference shots by microphone energy, without claiming speaker ground truth.
Input is the aligned 10ms RMS JSON produced by extract-reference.py, plus reference cuts.
"""
import argparse, csv, json, pathlib
import numpy as np
from compare import frames, validate

def audit(raw, reference, fps, candidate=None):
    ids=raw['channelIds'];energy=np.asarray(raw['envelopes'],dtype=float)
    if len(ids)!=2 or energy.shape[0]!=2:raise ValueError('Two matched microphones are required')
    duration=validate(reference)
    if abs(duration-raw['duration'])>1e-6:raise ValueError('Reference and audio durations differ')
    rows=[];groups={key:[] for key in ['same_microphone_dominant','opposite_microphone_dominant','mixed']}
    count=round(duration*fps);expected=np.array(frames(reference,fps,count))
    actual=np.array(frames(candidate,fps,count)) if candidate is not None else None
    if actual is not None and None in actual:raise ValueError('Candidate has uncovered frames')
    for i,cut in enumerate(reference):
        camera=ids.index(cut['channelId']);a=round(cut['timestamp']*100);b=round((cut['timestamp']+cut['duration'])*100)
        mean=energy[:,a:b].mean(axis=1);ratio=float(mean[camera]/max(mean[1-camera],1e-12))
        category='same_microphone_dominant' if ratio>3 else 'opposite_microphone_dominant' if ratio<1/3 else 'mixed'
        start=round(cut['timestamp']*fps);stop=round((cut['timestamp']+cut['duration'])*fps)
        row=dict(index=i,startSeconds=cut['timestamp'],durationSeconds=cut['duration'],camera=cut['channelId'],ownRms=float(mean[camera]),otherRms=float(mean[1-camera]),ownToOtherRatio=ratio,category=category,previousDuration=reference[i-1]['duration'] if i else None)
        if actual is not None:row['matchingFrames']=int(np.count_nonzero(expected[start:stop]==actual[start:stop]))
        row['evaluatedFrames']=stop-start;rows.append(row);groups[category].append(row)
    summary={}
    for key,shots in groups.items():
        n=sum(s['evaluatedFrames'] for s in shots)
        summary[key]={'shots':len(shots),'seconds':n/fps,'medianDurationSeconds':float(np.median([s['durationSeconds'] for s in shots])) if shots else None}
        if actual is not None and n:summary[key]['cameraAgreement']=sum(s['matchingFrames'] for s in shots)/n
    return rows,{'categories':summary,'note':'RMS dominance is a reproducible acoustic proxy. These categories are not independently verified speaker labels or proof of AutoCut intent.'}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input',type=pathlib.Path);p.add_argument('reference',type=pathlib.Path);p.add_argument('--candidate',type=pathlib.Path);p.add_argument('--fps',type=float,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args()
    rows,summary=audit(json.loads(a.input.read_text()),json.loads(a.reference.read_text()),a.fps,json.loads(a.candidate.read_text()) if a.candidate else None)
    a.output.mkdir(parents=True,exist_ok=True)
    with (a.output/'shot-audit.csv').open('w') as f:
        writer=csv.DictWriter(f,fieldnames=rows[0]);writer.writeheader();writer.writerows(rows)
    (a.output/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
