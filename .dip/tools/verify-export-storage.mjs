import { spawnSync } from 'node:child_process';
const checks = [
  ['node', ['classic/scripts/test-web.mjs',
    'src/export/__tests__/scratch.test.ts',
    'src/export/__tests__/audio-scratch.test.ts',
    'src/export/__tests__/disk-target.test.ts',
    'src/export/__tests__/audio-source-windows.test.ts',
    'src/export/__tests__/audio-quality.test.ts',
    'src/export/__tests__/pcm-file.test.ts',
    'src/export/__tests__/streaming-browser.test.ts',
    'src/core/__tests__/canonical-export.test.ts',
    '--jobs=1', '--timeout=300000', '--test-timeout=240000']],
  ['node', ['classic/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'classic/apps/web/tsconfig.build.json']],
];
for (const [command, args] of checks) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', timeout: 330000,
    env: { ...process.env, OPENCUT_STREAM_EXPORT_TEST: '1' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
