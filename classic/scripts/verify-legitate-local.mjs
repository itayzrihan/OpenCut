import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const report = join(root, '.local/legitate-only-setup/configured');
await mkdir(report, { recursive: true });
const checks = [
  ['auth', ['classic/scripts/test-web.mjs', 'src/accounts/server.test.ts', 'src/accounts/legitate-server.test.ts', 'src/accounts/legitate-start.test.ts', 'src/accounts/legitate-callback.test.ts', 'src/accounts/legitate-oidc.test.ts', 'src/accounts/legitate-only-api.test.ts', '--jobs=1', `--report=${join(report, 'auth')}`], root],
  ['launcher', ['--test', 'classic/scripts/local-production/server.test.mjs', 'classic/scripts/local-production/prune-releases.test.mjs', 'classic/scripts/local-production/public-assets.test.mjs', 'classic/scripts/local-production/standalone.test.mjs'], root],
  ['production-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.build.json'], join(root, 'classic/apps/web')],
  ['feature-test-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.peer-sync-test.json'], join(root, 'classic/apps/web')],
];
const results = [];
for (const [name, args, cwd] of checks) {
  const result = spawnSync(process.execPath, args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 ** 2 });
  await writeFile(join(report, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  results.push({ name, exitCode: result.status ?? 1 });
  await writeFile(join(report, 'summary.json'), JSON.stringify({ results }, null, 2));
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) { console.error((result.stdout || '') + (result.stderr || '')); process.exit(1); }
}
