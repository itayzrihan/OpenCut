import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const folder = '.local/smart-takes-2026-10-29';
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  if(result.stdout.trim()) console.log(result.stdout.trim());
}
run('cargo', ['test', '--manifest-path', 'classic/Cargo.toml', '-q', '-p', 'timeline']);
run('cargo', ['test', '-q', '-p', 'opencut-editor-api', '--test', 'classic_takes'], {
  OPENCUT_TAKE_FIXTURE: resolve(folder, 'session-bundle.json'),
  OPENCUT_TAKE_AUDIO: resolve(folder, 'audio-evidence.json'),
});
run('node', ['classic/scripts/test-web.mjs',
  'src/ai/__tests__/smart-takes-task.test.ts', 'src/ai/__tests__/smart-takes-plan.test.ts',
  'src/core/__tests__/canonical-smart-takes.test.ts', 'src/timeline/__tests__/smart-silence.test.ts',
  'src/timeline/__tests__/cut-silence.test.ts', 'src/timeline/smart-takes/audio-evidence.test.ts',
  'src/timeline/components/__tests__/cut-silence-toolbar-options.test.ts', 'src/transcription/windows.test.ts',
  `--report=${folder}/configured-web`]);
run('node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']);
run('git', ['diff', '--check', '--', 'classic', 'crates', 'analysis/smart-takes-2026-10-29']);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const evidence = await json('analysis/smart-takes-2026-10-29/verification.json');
assert(evidence.editorReloaded && evidence.cleanupSucceeded && evidence.alternativeSwitchAfterCleanup);
assert(evidence.sourceArchivePreserved && evidence.captionWordsPreserved && evidence.framingPreserved);
const before = await json(join(folder, 'project-before.json'));
const after = await json(evidence.projectPath);
const original = before.scenes.find(s => s.id === evidence.sceneId);
const current = after.scenes.find(s => s.id === evidence.sceneId);
assert.deepEqual(current.takeAssembly.sourceTracks, original.takeAssembly.sourceTracks);
assert.deepEqual(current.takeAssembly.sourceWords, original.takeAssembly.sourceWords);
assert.deepEqual(current.takeAssembly.plan.groups.map(g => g.alternatives), original.takeAssembly.plan.groups.map(g => g.alternatives));
const words = scene => scene.tracks.overlay.flatMap(t => t.captionSource?.words ?? []).map(w => w.text);
assert.deepEqual(words(current), words(original));
assert(current.tracks.main.elements.every(e => e.params['transform.scaleX'] === 1.27 && e.params['transform.scaleY'] === 1.27));
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
console.log('Verified canonical take integrity, live project preservation and production source fingerprint.');
