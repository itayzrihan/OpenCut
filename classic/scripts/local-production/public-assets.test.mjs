import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stagePublicAssets } from './public-assets.mjs';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const assetPath = 'models/Xenova/modnet/config.json';
const bytes = execFileSync('git', ['show', `HEAD:classic/apps/web/public/${assetPath}`], { cwd: repository, windowsHide: true });
const asset = { path: assetPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('release assets are restored and verified without changing deleted working files; unsafe paths and mismatches fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencut-public-assets-'));
  try {
    const source = join(root, 'public'); await mkdir(source);
    const manifest = assets => writeFile(join(source, 'background-removal-assets.json'), JSON.stringify({ model: { id: 'fixture' }, assets }));
    await manifest([asset]);
    const destination = join(root, 'release-public');
    const restored = await stagePublicAssets({ repository, publicRoot: source, destination, commit: 'HEAD' });
    assert.equal(restored.length, 1);
    assert.deepEqual(await readFile(join(destination, asset.path)), bytes);
    assert.equal(await access(join(source, asset.path)).then(() => true, () => false), false);
    execFileSync(process.execPath, [join(repository, 'classic/apps/web/scripts/verify-background-removal-assets.mjs'), '--public-root', destination]);
    await manifest([{ ...asset, sha256: '0'.repeat(64) }]);
    await assert.rejects(stagePublicAssets({ repository, publicRoot: source, destination: join(root, 'mismatch'), commit: 'HEAD' }), /verification/);
    await manifest([{ ...asset, path: '../../outside.json' }]);
    await assert.rejects(stagePublicAssets({ repository, publicRoot: source, destination: join(root, 'unsafe'), commit: 'HEAD' }), /escaped/);
  } finally {
    assert.match(relative(resolve(tmpdir()), resolve(root)), /^opencut-public-assets-[^\\/]+$/);
    await rm(resolve(root), { recursive: true, force: true });
  }
});
