import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}
run('node', ['classic/scripts/test-web.mjs',
  'src/core/managers/__tests__/project-session-lifecycle.test.ts',
  'src/editor/__tests__/snapshot.test.ts',
  'src/editor/__tests__/ownership-scene-selector.test.ts',
  'src/editor/__tests__/project-loading.test.ts',
  'src/core/__tests__/canonical-scene-automation.test.ts',
  'src/services/storage/__tests__/project-source-roundtrip.test.ts',
  '--jobs=2', '--report=.local/projects-page-2026-10-23/configured-tests']);
run('node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']);
run('git', ['diff', '--check']);

const evidence = JSON.parse(await readFile('analysis/projects-page-2026-10-23/live-verification.json', 'utf8'));
assert(evidence.projectsVisible && evidence.directReloadPassed && evidence.noReactErrors);
const projectsRoot = join(homedir(), 'Movies/OpenCut Accounts/data', evidence.accountId, 'projects');
const before = JSON.parse(await readFile('.local/projects-page-2026-10-23/project-hashes-before.json', 'utf8'));
const after = {};
for (const item of await readdir(projectsRoot, { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  try {
    after[item.name] = createHash('sha256').update(await readFile(join(projectsRoot, item.name, 'project.json'))).digest('hex');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
assert.deepEqual(after, before, 'Opening the library must not modify project documents');
const current = JSON.parse(await readFile(join(homedir(), 'Library/Application Support/OpenCut Local/current.json'), 'utf8'));
assert.equal(current.id, evidence.productionRelease);
const sourceHash = createHash('sha256');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 ** 2 }).toString().split('\0').filter(Boolean).sort();
for (const file of files) {
  if (file.endsWith('/next-env.d.ts')) continue;
  if (!/^(classic\/(apps\/(web|electron\/app)|rust|packages|patches)\/|crates\/|resources\/|Cargo\.(toml|lock)$|classic\/(package\.json|bun\.lock)$)/.test(file)) continue;
  sourceHash.update(file);
  try { sourceHash.update(await readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') sourceHash.update('deleted'); else throw error; }
}
assert.equal(current.fingerprint, sourceHash.digest('hex'));
assert((await fetch('http://localhost:3211/projects')).ok);
console.log(JSON.stringify({ passed: true, unchangedProjectDocuments: Object.keys(after).length, release: current.id }));
