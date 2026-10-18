import json,pathlib,hashlib,subprocess,re
ev=pathlib.Path(__file__).parent
receipt=json.loads((ev/'receipt.json').read_text())
manifest=json.loads((ev/'package-manifest.json').read_text())
repo=pathlib.Path(receipt['localPath'])
for f in manifest['files']:
 assert hashlib.sha256((repo/f['path']).read_bytes()).hexdigest()==f['sha256'],f['path']
for skill in ['strategic-teaser-compression','visual-teaser-editing']:
 subprocess.run(['/tmp/teaser-skills-validation-20261015/bin/python','/Users/itayzrihan/.codex/skills/.system/skill-creator/scripts/quick_validate.py',str(repo/'skills'/skill)],check=True,capture_output=True)
 for p in (repo/'skills'/skill).rglob('*.md'):
  for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',p.read_text()):
   if '://' in target or target.startswith('#'):continue
   resolved=(p.parent/target.split('#',1)[0]).resolve()
   assert resolved.is_relative_to(repo) and resolved.exists(),target
ledger=json.loads(subprocess.check_output(['python3',str(repo/'skills/strategic-teaser-compression/scripts/check_edit_plan.py'),str(repo/'skills/strategic-teaser-compression/references/edit-plan-example.json')],text=True))
assert ledger['valid'] and ledger['totalSeconds']==60
meta=json.loads(subprocess.check_output(['gh','repo','view','itayzrihan/teaser-editing-skills','--json','url,isPrivate'],text=True))
assert meta['isPrivate'] and meta['url']==receipt['url']
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=repo,text=True).split()[0]
assert head==remote==receipt['commit']
tree=json.loads(subprocess.check_output(['gh','api','repos/itayzrihan/teaser-editing-skills/git/trees/main?recursive=1'],text=True))
remotePaths={x['path'] for x in tree['tree'] if x['type']=='blob'}
assert all(f['path'] in remotePaths for f in manifest['files'])
assert receipt['secretScanPassed']
print(json.dumps({'passed':True,'url':meta['url'],'private':True,'commit':head,'packagedFiles':len(manifest['files']),'skills':2}))
