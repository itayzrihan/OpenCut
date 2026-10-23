import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  console.log(r.stdout.trim());
}
run('node', ['classic/scripts/test-web.mjs',
  'src/core/managers/__tests__/timeline-manager-preview.test.ts',
  'src/services/renderer/__tests__/visual-node-transform.test.ts',
  'src/components/editor/panels/properties/__tests__/element-param-playhead.test.ts',
  'src/components/editor/panels/properties/__tests__/bulk-selection.test.ts',
  '--report=.local/scale-preview-2026-10-23/configured-tests']);
run('cargo', ['test', '-q', '-p', 'opencut-editor-api', '--test', 'classic_update']);
run('node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']);
run('git', ['diff', '--check']);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = await json('analysis/scale-preview-2026-10-23/verification.json');
assert(evidence.disabledNoticeVisible && evidence.selectedNameVisible && evidence.selectedTrackVisible);
assert(evidence.pausedScaleChanged && evidence.testUndone && evidence.savedAfterReload);
const before = await json('.local/scale-preview-2026-10-23/project-before.json');
const after = await json(join(homedir(), 'Movies/OpenCut Accounts/data', evidence.accountId, 'projects', evidence.projectId, 'project.json'));
assert.equal(after.scenes.length, before.scenes.length);
const content = ({ updatedAt, ...scene }) => scene;
for (const scene of before.scenes) assert.deepEqual(content(after.scenes.find(s => s.id === scene.id)), content(scene));
assert.deepEqual(after.settings, before.settings);
const release = await json(join(homedir(), 'Library/Application Support/OpenCut Local/current.json'));
assert.equal(release.id, evidence.release);
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 ** 2 }).toString().split('\0').filter(Boolean).sort();
const hash = createHash('sha256');
for (const file of files) {
  if (file.endsWith('/next-env.d.ts')) continue;
  if (!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file)) continue;
  hash.update(file);
  try { hash.update(await readFile(file)); } catch (error) { if (error.code === 'ENOENT') hash.update('deleted'); else throw error; }
}
assert.equal(hash.digest('hex'), release.fingerprint);
assert((await fetch('http://localhost:3211/projects')).ok);
console.log(JSON.stringify({ preservedScenes: before.scenes.length, regressionTests: 15, release: release.id, pausedScaleVerified: true }));
