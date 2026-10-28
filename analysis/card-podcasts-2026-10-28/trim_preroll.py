"""Prepare an undoable canonical trim of video before both external mics began."""
import copy,json,math
from pathlib import Path
P=Path(__file__).resolve().parent;ledger=[]
for n in ['0160','0159','0158','0157']:
 raw=(P/f'project-{n}-before-preroll.json').read_text();j=json.loads(raw);original=copy.deepcopy(j);aud=[t for t in j['scene']['tracks'] if t['type']=='audio'];cut=math.ceil(max(t['elements'][0]['startTime'] for t in aud)/4800)*4800
 assert 0<cut<60*120000
 for t in j['scene']['tracks']:
  kept=[]
  for e in t['elements']:
   start=e['startTime'];end=start+e['duration']
   if end<=cut:continue
   if start<cut:
    amount=cut-start;e['duration']-=amount
    if e['type'] in ['video','audio']:e['trimStart']+=amount
   e['startTime']=max(0,start-cut);kept.append(e)
  t['elements']=kept
 for t in aud:assert t['elements'][0]['startTime']==0
 new=json.dumps(j,ensure_ascii=False,sort_keys=True,indent=2)
 (P.parents[1]/'.local/card-podcasts-2026-10-28'/f'preroll-edits-{n}.json').write_text(json.dumps({'edits':[{'oldText':raw,'newText':new}]},ensure_ascii=False))
 (P.parents[1]/'.local/card-podcasts-2026-10-28'/f'project-{n}-expected.json').write_text(new);ledger.append({'session':n,'removedVideoOnlyPrerollSeconds':cut/120000,'method':'First25fps frame after both external mic recordings begin; no external-mic speech discarded before that frame.'})
 print(n,cut/120000)
(P/'preroll-ledger.json').write_text(json.dumps(ledger,indent=2))
