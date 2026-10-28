"""Prepare canonical source edits retaining footage after the longest raw camera ends."""
import copy,json,math
from pathlib import Path
P=Path(__file__).resolve().parent
for n in ['0160','0159']:
 raw=(P/f'project-{n}.json').read_text();j=json.loads(raw);tracks=j['scene']['tracks'];video=next(t for t in tracks if t['name'].startswith('Routed 2'));last=video['elements'][-1];end=last['startTime']+last['duration'];remaining=last['trimEnd'];tail=math.floor(remaining/4800)*4800
 assert 0<tail<12*120000
 edits=[]
 def change(old,new):
  assert raw.count(old)==1,(n,old[:100],raw.count(old));edits.append(dict(oldText=old,newText=new))
 def itemtext(e):return json.dumps(e,ensure_ascii=False,sort_keys=True,indent=2).replace('\n','\n          ')
 new=copy.deepcopy(last);new.update(id=f'card-completion-tail-{n}-A4',enabled=True,startTime=end,duration=tail,trimStart=last['trimStart']+last['duration'],trimEnd=remaining-tail)
 change(itemtext(last),itemtext(last)+',\n          '+itemtext(new))
 for track in tracks:
  if track['type'] not in ['audio','effect']:continue
  assert len(track['elements'])==1;e=track['elements'][0];new=copy.deepcopy(e);new['duration']+=tail
  if track['type']=='audio':
   assert new['trimEnd']>=tail;new['trimEnd']-=tail
  change(itemtext(e),itemtext(new))
 out=raw
 for e in edits:out=out.replace(e['oldText'],e['newText'])
 obj=json.loads(out);assert obj['scene']['id']==j['scene']['id']
 (P.parents[1]/'.local/card-podcasts-2026-10-28'/f'tail-edits-{n}.json').write_text(json.dumps({'edits':edits},ensure_ascii=False,indent=2));print(n,'tail',tail/120000,'newduration',(end+tail)/120000)
