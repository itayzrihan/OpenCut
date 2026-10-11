"""Research only: infer edit decisions from audio with purged temporal validation.
No absolute timestamps, reference camera history, or cut-time lookup in features.
Dependencies: numpy, scipy, scikit-learn. Outputs stay in a caller-selected folder.
"""
import argparse, json, pathlib, sys, os
os.environ.setdefault('OMP_NUM_THREADS','2')
os.environ.setdefault('OPENBLAS_NUM_THREADS','2')
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from scipy.ndimage import uniform_filter1d
from compare import compare, frames

def features(envelopes, fps, frame_count):
    e=np.asarray(envelopes,dtype=np.float64)
    if e.shape[0]!=2:raise ValueError('This inference experiment requires two microphones')
    sample=np.minimum((np.arange(frame_count)/fps*100).astype(int),e.shape[1]-1)
    # Gain normalization uses audio only. No labels, dates, file names or time indices.
    scale=np.percentile(e,95,axis=1)[:,None].clip(1e-9)
    e=e/scale
    result=[];names=[]
    for seconds in [.04,.12,.4,1,2,4,8,16]:
        size=max(1,round(seconds*100))
        for position,shift in [('center',0),('past',-size//2),('future',size//2)]:
            avg=uniform_filter1d(e,size=size,axis=1,mode='nearest')[:,np.clip(sample+shift,0,e.shape[1]-1)]
            result.extend([np.log1p(avg[0]*10),np.log1p(avg[1]*10),np.log((avg[0]+.002)/(avg[1]+.002))])
            names.extend([f'{position}_{seconds}_mic0',f'{position}_{seconds}_mic1',f'{position}_{seconds}_ratio'])
    for offset in [-2,-1,-.5,-.2,0,.2,.5,1,2]:
        energy=uniform_filter1d(e,size=12,axis=1,mode='nearest')[:,np.clip(sample+round(offset*100),0,e.shape[1]-1)]
        result.extend([np.log1p(energy[0]*10),np.log1p(energy[1]*10)])
        names.extend([f'local_{offset}_mic0',f'local_{offset}_mic1'])
    return np.asarray(result,dtype=np.float32).T,names

def cuts_from_labels(labels,ids,fps):
    b=np.r_[0,np.flatnonzero(np.diff(labels))+1,len(labels)]
    return [dict(timestamp=int(a)/fps,duration=int(z-a)/fps,channelId=ids[int(labels[a])]) for a,z in zip(b[:-1],b[1:])]

def decode(probability, fps, min_seconds=1, max_seconds=20, transition_penalty=2):
    """Global offline camera plan with a legal shot duration, using audio probabilities only."""
    p=np.clip(probability,.001,.999)
    emissions=np.c_[np.log1p(-p),np.log(p)]
    total=np.vstack([np.zeros(2),emissions.cumsum(axis=0)])
    n=len(p);low=max(1,round(min_seconds*fps));high=max(low,round(max_seconds*fps))
    dp=np.full((n+1,2),-np.inf);back=np.zeros((n+1,2),dtype=np.int32);dp[0]=0
    from collections import deque
    queues=[deque(),deque()]
    for end in range(low,n+1):
        start=end-low
        for camera in range(2):
            q=queues[camera]
            value=dp[start,1-camera]-total[start,camera]
            if np.isfinite(value):
                while q and q[-1][1] < value:q.pop()
                q.append((start,value))
            while q and q[0][0]<end-high:q.popleft()
            if q:
                dp[end,camera]=total[end,camera]+q[0][1]-transition_penalty
                back[end,camera]=q[0][0]
    camera=int(np.argmax(dp[-1]));end=n;labels=np.zeros(n,dtype=np.int8)
    while end>0:
        start=int(back[end,camera]);labels[start:end]=camera;end=start;camera=1-camera
    return labels

def evaluate_blocks(probability, labels, ids, fps, folds, transition_penalty):
    """Decode each held-out block independently, never across a model boundary."""
    prediction=np.zeros(len(labels),dtype=np.int8);blocks=[]
    for lo,hi in zip(folds[:-1],folds[1:]):
        prediction[lo:hi]=decode(probability[lo:hi],fps,transition_penalty=transition_penalty)
        reference=cuts_from_labels(labels[lo:hi],ids,fps)
        candidate=cuts_from_labels(prediction[lo:hi],ids,fps)
        blocks.append(compare(reference,candidate,fps))
    n=sum(b['evaluatedFrames'] for b in blocks)
    reference_count=sum(b['referenceTransitions'] for b in blocks)
    candidate_count=sum(b['candidateTransitions'] for b in blocks)
    metrics={'fps':fps,'evaluatedFrames':n,'referenceTransitions':reference_count,'candidateTransitions':candidate_count,
             'cameraAgreement':sum(b['cameraAgreement']*b['evaluatedFrames'] for b in blocks)/n}
    for key in ['exactBoundaries','withinOneFrame','within250ms','withinOneSecond']:
        count=sum(b[key]['matches'] for b in blocks)
        precision=count/candidate_count if candidate_count else float(not reference_count)
        recall=count/reference_count if reference_count else float(not candidate_count)
        metrics[key]={'matches':count,'precision':precision,'recall':recall,'f1':2*precision*recall/(precision+recall) if precision+recall else 0}
    metrics['targetMet']=metrics['cameraAgreement']>=.99 and metrics['exactBoundaries']['precision']>=.99 and metrics['exactBoundaries']['recall']>=.99
    metrics['target']=.99;metrics['boundaryToleranceFrames']=0
    return prediction,metrics,blocks

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('input',type=pathlib.Path);ap.add_argument('reference',type=pathlib.Path,nargs='?');ap.add_argument('--predict-with',type=pathlib.Path);ap.add_argument('--export-model',action='store_true');ap.add_argument('--fps',type=float,default=25);ap.add_argument('--output',type=pathlib.Path,required=True);args=ap.parse_args()
    raw=json.loads(args.input.read_text());ids=raw['channelIds'];fps=args.fps;n=round(raw['duration']*fps)
    if args.predict_with:
        # Accept only a locally generated research bundle; inference does not read reference cuts.
        import joblib
        bundle=joblib.load(args.predict_with)
        x,names=features(raw['envelopes'],fps,n)
        if names!=bundle['features'] or fps!=bundle['fps']:raise ValueError('Incompatible feature contract or frame rate')
        probability=bundle['model'].predict_proba(x)[:,1]
        labels=decode(probability,fps,transition_penalty=bundle['transitionPenalty'])
        args.output.mkdir(parents=True,exist_ok=True)
        (args.output/'candidate-cuts.json').write_text(json.dumps(cuts_from_labels(labels,ids,fps),indent=2))
        print(json.dumps({'frames':n,'output':str(args.output),'referenceReadDuringInference':False}));return
    if args.reference is None:ap.error('Training requires reference cuts')
    reference=json.loads(args.reference.read_text())
    if set(ids)!=set(c['channelId'] for c in reference):raise ValueError('Camera IDs must match')
    labels=np.array([ids.index(v) for v in frames(reference,fps,n)],dtype=np.int8)
    x,names=features(raw['envelopes'],fps,n);out=args.output;out.mkdir(parents=True,exist_ok=True)
    reports=[]
    if args.export_model:
        import joblib
        model=HistGradientBoostingClassifier(max_iter=120,max_leaf_nodes=7,min_samples_leaf=150,l2_regularization=20,learning_rate=.08,early_stopping=False,random_state=1701)
        indices=np.arange(0,n,2);model.fit(x[indices],labels[indices])
        joblib.dump({'model':model,'features':names,'fps':fps,'transitionPenalty':20},out/'experimental-model.joblib')
        prediction=decode(model.predict_proba(x)[:,1],fps,transition_penalty=20)
        metrics=compare(reference,cuts_from_labels(prediction,ids,fps),fps)
        (out/'training-replay-metrics.json').write_text(json.dumps({'warning':'Training replay only, not validation accuracy','metrics':metrics},indent=2))
    # Separate contiguous validation blocks, with 20s excluded around each block.
    # Existing hand-tuning has seen this recording; call these out-of-fold, not unseen-project scores.
    folds=np.linspace(0,n,6,dtype=int);purge=round(20*fps)
    for leaf in [7,31]:
        probability=np.zeros(n);train_scores=[]
        for f,(lo,hi) in enumerate(zip(folds[:-1],folds[1:])):
            mask=np.ones(n,dtype=bool);mask[max(0,lo-purge):min(n,hi+purge)]=False
            indices=np.flatnonzero(mask)[::2]
            model=HistGradientBoostingClassifier(max_iter=120,max_leaf_nodes=leaf,min_samples_leaf=150,l2_regularization=20,learning_rate=.08,early_stopping=False,random_state=1701)
            model.fit(x[indices],labels[indices]);probability[lo:hi]=model.predict_proba(x[lo:hi])[:,1]
            train_scores.append(float(model.score(x[indices],labels[indices])))
            print(json.dumps(dict(leaves=leaf,fold=f,trainAgreement=train_scores[-1],validationAgreement=float(np.mean((probability[lo:hi]>.5)==labels[lo:hi])))),flush=True)
        np.save(out/f'probabilities-{leaf}.npy',probability)
        for penalty in [0,5,20]:
            pred,metrics,blocks=evaluate_blocks(probability,labels,ids,fps,folds,penalty)
            cuts=cuts_from_labels(pred,ids,fps)
            report=dict(leaves=leaf,transitionPenalty=penalty,meanTrainingAgreement=float(np.mean(train_scores)),metrics=metrics,validationBlocks=blocks)
            reports.append(report);(out/f'cuts-{leaf}-{penalty}.json').write_text(json.dumps(cuts,indent=2));print(json.dumps(report),flush=True)
    (out/'results.json').write_text(json.dumps(reports,indent=2));(out/'features.json').write_text(json.dumps(names,indent=2))
    (out/'protocol.json').write_text(json.dumps({'blocks':folds.tolist(),'purgeSeconds':20,'trainingStrideFrames':2,'randomSeed':1701,'inputFile':str(args.input),'referenceFile':str(args.reference),'note':'Each block is decoded independently. Concatenated cuts are a diagnostic mosaic of five models, not a deployable single-model timeline.'},indent=2))
if __name__=='__main__':main()
