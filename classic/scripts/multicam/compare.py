"""Compare camera decisions, never reward same-camera splits as successful cuts.
Usage: python3 compare.py reference.json candidate.json --fps 25 --output report.json
Both inputs are arrays of {timestamp,duration,channelId}, seconds, contiguous from zero.
"""
import argparse, json, math, statistics

def validate(cuts):
    end = 0.0
    for cut in cuts:
        if not all(math.isfinite(cut[k]) for k in ['timestamp', 'duration']) or cut['duration'] <= 0 or abs(cut['timestamp']-end)>1e-6:
            raise ValueError('Cuts must be finite, positive and contiguous from zero')
        end = cut['timestamp']+cut['duration']
    if not cuts: raise ValueError('Empty camera plan')
    return end

def frames(cuts, fps, count):
    result = [None]*count
    for c in cuts:
        start = max(0, math.floor(c['timestamp']*fps+0.5+1e-7))
        end = min(count, math.floor((c['timestamp']+c['duration'])*fps+0.5+1e-7))
        result[start:end] = [c['channelId']]*(end-start)
    return result

def boundaries(labels):
    return [(i, v) for i,v in enumerate(labels) if i and v != labels[i-1]]

def match(reference, predicted, tolerance):
    # Ordered maximum-cardinality matching, then minimum total timing error.
    # A nearest-pair greedy match can consume a boundary needed by another pair.
    rows, cols = len(reference), len(predicted)
    scores = [[(0, 0)] * (cols + 1) for _ in range(rows + 1)]
    actions = [bytearray(cols + 1) for _ in range(rows + 1)]
    for i, (r, rc) in enumerate(reference, 1):
        for j, (p, pc) in enumerate(predicted, 1):
            best, action = scores[i-1][j], 1
            if scores[i][j-1] > best:
                best, action = scores[i][j-1], 2
            if rc == pc and abs(r-p) <= tolerance:
                count, negative_error = scores[i-1][j-1]
                candidate = (count+1, negative_error-abs(r-p))
                if candidate > best:
                    best, action = candidate, 3
            scores[i][j], actions[i][j] = best, action
    errors = []
    i, j = rows, cols
    while i and j:
        action = actions[i][j]
        if action == 3:
            errors.append(abs(reference[i-1][0]-predicted[j-1][0])); i -= 1; j -= 1
        elif action == 1: i -= 1
        else: j -= 1
    precision=len(errors)/len(predicted) if predicted else float(not reference)
    recall=len(errors)/len(reference) if reference else float(not predicted)
    return {'matches':len(errors),'precision':precision,'recall':recall,'f1':2*precision*recall/(precision+recall) if precision+recall else 0,'medianErrorFrames':statistics.median(errors) if errors else None}

def compare(reference, candidate, fps, target=.99, boundary_tolerance_frames=0):
    if not math.isfinite(fps) or fps <= 0: raise ValueError("Positive finite fps required")
    if not .0 < target <= 1.0: raise ValueError("Target must be in (0, 1]")
    if not isinstance(boundary_tolerance_frames, int) or boundary_tolerance_frames < 0: raise ValueError("Boundary tolerance must be a nonnegative frame count")
    duration=validate(reference)
    if abs(validate(candidate)-duration)>1/fps: raise ValueError('Different total durations')
    n=math.floor(duration*fps+0.5+1e-7)
    if n < 2: raise ValueError('At least two reference frames are required')
    a,b=frames(reference,fps,n),frames(candidate,fps,n)
    ra,pb=boundaries(a),boundaries(b)
    if None in a or None in b: raise ValueError('Uncovered frames')
    split=int(n*0.7)
    agreement=sum(x==y for x,y in zip(a,b))/n
    one_frame=match(ra,pb,1)
    gate=match(ra,pb,boundary_tolerance_frames)
    return {'fps':fps,'durationSeconds':duration,'evaluatedFrames':n,'referenceTransitions':len(ra),'candidateTransitions':len(pb),
            'cameraAgreement':agreement,
            'first70PercentAgreement':sum(a[i]==b[i] for i in range(split))/split,
            'last30PercentAgreement':sum(a[i]==b[i] for i in range(split,n))/(n-split),
            'exactBoundaries':match(ra,pb,0),'withinOneFrame':one_frame,'within250ms':match(ra,pb,math.floor(fps*0.25)),
            'withinOneSecond':match(ra,pb,math.floor(fps)),
            'target':target,'boundaryToleranceFrames':boundary_tolerance_frames,
            'targetMet':agreement>=target and gate['precision']>=target and gate['recall']>=target,
            'identical':a==b and ra==pb}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('reference');p.add_argument('candidate');p.add_argument('--fps',type=float,required=True);p.add_argument('--output');p.add_argument('--target',type=float,default=.99);p.add_argument('--tolerance-frames',type=int,default=0);p.add_argument('--require-target',action='store_true');a=p.parse_args()
    report=compare(json.load(open(a.reference)),json.load(open(a.candidate)),a.fps,a.target,a.tolerance_frames)
    text=json.dumps(report,indent=2);print(text)
    if a.output:open(a.output,'w').write(text+'\n')
    if a.require_target and not report['targetMet']:raise SystemExit(1)
