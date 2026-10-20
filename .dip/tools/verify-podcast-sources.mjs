import { spawnSync } from 'node:child_process';
const checks = [
 ['cargo', ['test', '-p', 'opencut-editor-api', '--test', 'classic_multicam', '--test', 'classic_podcast']],
 ['node', ['classic/scripts/test-web.mjs', 'src/core/__tests__/canonical-multicam.test.ts', 'src/podcast-sync/__tests__/unified-engine.test.ts', '--jobs=1', '--timeout=240000', '--test-timeout=120000']],
];
for (const [command, args] of checks) {
 const result = spawnSync(command, args, { stdio: 'inherit' });
 if (result.status !== 0) process.exit(result.status ?? 1);
}
