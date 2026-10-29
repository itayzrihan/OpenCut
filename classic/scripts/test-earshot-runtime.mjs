#!/usr/bin/env node
// Real WASM integration: no Python installed on the machine is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const classic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(classic, 'apps/web/public/earshot/runtime');
const require = createRequire(import.meta.url);
const { loadPyodide } = require(path.join(root, 'pyodide.js'));
const p = await loadPyodide({ indexURL: root + '/', stdout:()=>{}, stderr:()=>{} });
await p.loadPackage(['numpy', 'scipy']);
const sources = JSON.parse(await fs.readFile(path.join(root, 'source-files.json'), 'utf8'));
for (const [f, s] of Object.entries(sources)) {
  const dest = '/earshot-project/' + f;
  p.FS.mkdirTree(path.dirname(dest)); p.FS.writeFile(dest, s);
}
p.runPython("import sys; sys.path.insert(0, '/earshot-project')");
p.runPython(`from earshot.forge import dsp, fx
_original = {name: getattr(dsp if name in ('_svf','_osc') else fx, name) for name in ('_svf','_osc','_allpass','_fdn','_follow','_rise','_release')}
`);
require(path.join(root, 'kernels.js'));
p.globals.set('_earshot_kernels', globalThis.earshotKernels);
p.runPython(await fs.readFile(path.join(root, 'renderer.py'), 'utf8'));
p.runPython(`
r = np.random.default_rng(5)
x = r.normal(size=2048)
for name, args in [('_svf',(x,np.linspace(200,4000,len(x)),np.ones(len(x))*.71,1)),('_osc',(np.linspace(200,4000,2048),2,.3)),('_allpass',(x,13,.4)),('_follow',(x,.1,.8)),('_rise',(x,.4)),('_release',(x,.9))]:
    actual = getattr(dsp if name in ('_svf','_osc') else fx,name)(*args)
    expected = _original[name](*args)
    assert np.allclose(actual,expected,rtol=1e-10,atol=1e-10),name
N=4
args=(x[:,None],np.ones((1,N)),r.normal(size=(N,2)),np.array([41.,59.,79.,101.]),np.ones(N)*.2,np.ones(N)*.3,np.zeros(N),np.ones(N)*.7,np.zeros(N),np.zeros(N),np.ones(N)*.8,np.zeros(N),np.zeros(N),len(x))
assert np.allclose(fx._fdn(*args),_original['_fdn'](*args),rtol=1e-10,atol=1e-10),'fdn'
`);
console.log('PASS: seven accelerated kernels match original Earshot equations (1e-10 tolerance).');
const ids = p.runPython('bank.ids()').toJs();
assert.equal(ids.length, 252);
const failures = [];
const selectedIds = process.argv.includes("--smoke") ? ["ui_pop/soft", "fit/click/floss_lid", "whoosh_fast/crisp"] : ids;
for (let i=0; i<selectedIds.length; i++) {
  p.globals.set('_sid', selectedIds[i]);
  const result = JSON.parse(p.runPython(`_entry=bank.get(_sid)
_y,_meta=bank.render(_sid,checks=False)
_delta=bank.compare_fp(_entry['meta'],_y)
json.dumps(_delta)`));
  if (result.len_diff !== 0 || Math.abs(result.peak_diff_ms) > 5 || result.env_db > .5) failures.push({ id: selectedIds[i], ...result });
  if ((i+1)%25 === 0) console.log(`Rendered and fingerprinted ${i+1}/252 bank sounds.`);
}
assert.deepEqual(failures, [], 'All upstream bank fingerprints must match in WASM.');
p.runPython(`
spec={'presetId':'ui_pop/soft','seed':123,'duration':.75,'echo':{'delay':.08,'feedback':.3,'mix':.2},'sourceCode':'def render(params, r):\\n t=np.arange(round(params["duration"]*48000))/48000\\n return np.sin(2*np.pi*330*t)*np.exp(-t*8)'}
a=render_clip(spec)
b=render_clip(spec)
assert a.shape==(1,36000) and np.array_equal(a,b) and np.isfinite(a).all()
assert abs(a[0,0])<1e-6 and abs(a[0,-1])<1e-6
assert 'torch' not in sys.modules and 'transformers' not in sys.modules
`);
p.runPython(`
wrapper='from earshot.forge import bank\\ndef render(params,r):\\n entry=bank.get(source_spec["presetId"])\\n if entry.get("type","forge")=="forge": entry["params"].update({key:value for key,value in params.items() if key in entry["params"]})\\n return bank.render(entry,seed=source_spec["seed"],dur=source_spec["duration"],apex=source_spec.get("apex"),pitch=source_spec.get("pitch"),checks=False)[0]'
for sid,extra in [('ui_pop/soft',{'pitch':'A4'}),('whoosh_fast/crisp',{'apex':.1}),('fit/click/floss_lid',{})]:
 spec={'presetId':sid,'seed':9,'duration':.3,**extra}
 a=render_clip(spec)
 b=render_clip({**spec,'sourceCode':wrapper})
 assert np.array_equal(a,b),sid
`);
for (const duration of [0.02, 0.020010416666666666, 0.02003125, 0.020052083333333332]) {
  p.globals.set('_boundary_duration', duration);
  const frames = p.runPython(`
spec={'presetId':'ui_pop/soft','seed':9,'duration':_boundary_duration}
ordinary=render_clip(spec)
custom=render_clip({**spec,'sourceCode':'def render(params,r):\\n return np.ones(round(params["duration"]*48000))'})
assert ordinary.shape[1]==custom.shape[1]
ordinary.shape[1]`);
  assert.equal(frames, Math.round(duration * 48000), `PCM sample count for ${duration}`);
}
console.log('PASS: builtin/custom PCM lengths match JavaScript at half-sample boundaries.');
console.log(`PASS: ${selectedIds.length} sound fingerprints, deterministic custom code/echo, edit-wrapper PCM parity, bounded PCM, no ML/model imports.`);
