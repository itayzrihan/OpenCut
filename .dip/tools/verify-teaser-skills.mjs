import {readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const base=resolve('analysis/teaser-reference-2026-10-14');
const python=resolve('.local/teaser-reference-2026-10-14/validator-env/bin/python');
const names=['strategic-teaser-compression','visual-teaser-editing'];
const installed=join(homedir(),'.codex/skills');
function run(args,expected=0,input){const r=spawnSync(python,args,{encoding:'utf8',input});if(r.status!==expected)throw Error(`Command failed (${r.status}, expected ${expected}): ${r.stdout}\n${r.stderr}`);return r.stdout;}
const hash=b=>createHash('sha256').update(b).digest('hex');
async function files(dir){let result=[];for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='__pycache__')continue;const p=join(dir,e.name);if(e.isDirectory())result.push(...await files(p));else result.push(p);}return result;}
for(const name of names){
 const source=join(base,'skills',name),dest=join(installed,name);
 for(const dir of [source,dest])console.log(run([join(homedir(),'.codex/skills/.system/skill-creator/scripts/quick_validate.py'),dir]).trim());
 for(const path of await files(source)){
  const relative=path.slice(source.length+1);if(hash(await readFile(path))!==hash(await readFile(join(dest,relative))))throw Error(`Installed skill differs: ${name}/${relative}`);
  if(path.endsWith('.md'))for(const match of (await readFile(path,'utf8')).matchAll(/\]\(([^)]+)\)/g)){
   const link=match[1].split('#')[0];if(!link||/^[a-z]+:\/\//.test(link))continue;
   await stat(resolve(dirname(path),link));await stat(resolve(dirname(join(dest,relative)),link));
  }
 }
}
const evidence=JSON.parse(await readFile(join(base,'evidence.json'),'utf8'));
if(hash(await readFile(evidence.source))!==evidence.sha256)throw Error('Source changed');
let cursor=0;for(const state of evidence.visualStates){if(Math.abs(state.start-cursor)>1e-5||state.end<=state.start||Math.abs(state.duration-(state.end-state.start))>1e-5)throw Error('Inconsistent visual clock');cursor=state.end;}
if(Math.abs(cursor-evidence.videoDuration)>1e-5)throw Error('Timeline misses tail');
const body=evidence.visualStates.filter(s=>s.end<=evidence.bodyEnd+1e-5);
if(body.length!==evidence.bodyStateCount)throw Error('Body count mismatch');
const totals=Object.fromEntries(['T','M','G'].map(kind=>[kind,body.filter(s=>s.kind===kind).reduce((s,x)=>s+x.duration,0)]));
for(const[k,v]of Object.entries(totals))if(Math.abs(v-evidence.bodyStateTotals[k])>.001)throw Error(`Timing total mismatch ${k}`);
for(const name of names){run(['-c','import sys,yaml; p=yaml.safe_load(open(sys.argv[1])); assert p["interface"]["display_name"]==sys.argv[2]',join(installed,name,'agents/openai.yaml'),name===names[0]?'בחירת קטעים מעניינים ביותר ודחיסה אסטרטגית שלהם':'עריכה ויזואלית']);}
const skill=join(installed,names[0]);
const example=JSON.parse(await readFile(join(skill,'references/edit-plan-example.json'),'utf8'));
const check=plan=>JSON.parse(run(['-c','import sys,json,runpy; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["check"](json.loads(sys.stdin.read()))))',join(skill,'scripts/check_edit_plan.py')],0,JSON.stringify(plan)));
if(check(example).totalSeconds!==60)throw Error('60-second budget failed');
const nonUnit=structuredClone(example);nonUnit.clips[0].sourceOut+=3;nonUnit.clips[0].playbackRate=2;nonUnit.clips[0].gapBeforeSeconds=1;nonUnit.ctaSeconds=2;
if(check(nonUnit).totalSeconds!==60)throw Error('Rate/gap calculation failed');
const adjacent=structuredClone(example);let position=0;for(const clip of adjacent.clips){const duration=clip.sourceOut-clip.sourceIn;clip.sourceIn=position;clip.sourceOut=position+duration;position+=duration;}
const disguised=check(adjacent);if(disguised.effectiveSourcePassages!==1||disguised.warnings.length<2)throw Error('Continuous passage disguised as many units was not flagged');
for(const mutate of [p=>p.outputSceneId=p.protectedSceneId,p=>p.ctaSeconds+=5,p=>p.clips[0].sourceOut=4000,p=>p.clips[0].playbackRate=0,p=>p.clips[1].id=p.clips[0].id,p=>p.clips[1].overlapWithPreviousSeconds=1]){
 const p=structuredClone(example);mutate(p);
 const r=spawnSync(python,['-c','import sys,json,runpy; m=runpy.run_path(sys.argv[1]); m["check"](json.loads(sys.stdin.read()))',join(skill,'scripts/check_edit_plan.py')],{input:JSON.stringify(p),encoding:'utf8'});
 if(r.status===0)throw Error('Invalid plan accepted');
}
console.log('PASS: both installed skills validate; linked references/images exist; source hash and whole timeline intact; budget/rate/gap and rejection checks passed');
