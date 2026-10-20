import { spawnSync } from 'node:child_process';
const checks = [
  ['cargo', ['test', '-p', 'opencut-editor-api', '--test', 'classic_export', '--test', 'classic_settings', '--no-default-features']],
  ['node', ['classic/scripts/test-web.mjs', 'src/core/__tests__/canonical-export.test.ts', 'src/services/renderer/__tests__/scale-frame-output.test.ts', 'src/services/renderer/__tests__/nested-opacity.test.ts', 'src/export/__tests__/video-encoding.test.ts', '--jobs=1', '--timeout=240000', '--test-timeout=120000']],
];
for (const [command, args] of checks) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 300000 });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
