import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const folder = '.local/take-replacement-2026-10-29';
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  if(result.stdout.trim()) console.log(result.stdout.trim());
}
run('cargo', ['test', '-q', '-p', 'opencut-editor-api', '--test', 'classic_takes'], {
  OPENCUT_EDITED_TAKE_FIXTURE: resolve(folder, 'project-before.json'),
});
run('node', ['classic/scripts/test-web.mjs', 'src/core/__tests__/canonical-smart-takes.test.ts', '--test-timeout=30000', `--report=${folder}/configured-web`]);
run('node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']);
run('git', ['diff', '--check', '--', 'classic', 'crates', 'analysis/take-replacement-2026-10-29']);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = await json('analysis/take-replacement-2026-10-29/verification.json');
assert(evidence.editorReloaded && evidence.liveAlternativeSwitch && evidence.liveUndoRestoredEdits);
assert(evidence.sourceArchivePreserved && evidence.unrelatedClipsPreserved);
const before = await json(join(folder, 'live-before.json'));
const after = await json(join(folder, 'live-switched.json'));
const undo = await json(join(folder, 'live-undone.json'));
const scene = p => p.scenes.find(s => s.id === evidence.sceneId);
const a = scene(before), b = scene(after), c = scene(undo);
assert.deepEqual(a.takeAssembly.sourceTracks, b.takeAssembly.sourceTracks);
assert.deepEqual(a.takeAssembly.plan.groups.map(g => g.alternatives), b.takeAssembly.plan.groups.map(g => g.alternatives));
const other = s => s.tracks.main.elements.filter(e => e.takeGroup?.groupIndex !== evidence.groupIndex).map(({startTime,...e}) => e);
assert.deepEqual(other(a), other(b));
assert.deepEqual(a.tracks, c.tracks);
assert.deepEqual(a.bookmarks, c.bookmarks);
const release = await json(join(homedir(), 'Library/Application Support/OpenCut Local/current.json'));
assert.equal(release.id, evidence.release);
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {maxBuffer:64*1024**2}).toString().split('\0').filter(Boolean).sort();
const hash = createHash('sha256');
for (const file of files) {
  if (file.endsWith('/next-env.d.ts')) continue;
  if (!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file)) continue;
  hash.update(file);
  try { hash.update(await readFile(file)); } catch (error) { if(error.code === 'ENOENT') hash.update('deleted'); else throw error; }
}
assert.equal(hash.digest('hex'), release.fingerprint);
assert((await fetch('http://localhost:3211/projects')).ok);
console.log('Verified edited take replacement, private regression, live preservation and exact production source.');
