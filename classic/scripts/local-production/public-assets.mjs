import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Keep deleted working-tree assets deleted. A complete release receives pinned
// originals from the selected Git commit in its own staging directory only.
export async function stagePublicAssets({ repository, publicRoot, destination, commit }) {
  await mkdir(destination, { recursive: true });
  await cp(publicRoot, destination, { recursive: true, verbatimSymlinks: true });
  const manifest = JSON.parse(await readFile(join(destination, 'background-removal-assets.json'), 'utf8'));
  const restored = [];
  for (const asset of manifest.assets) {
    const target = resolve(destination, asset.path);
    const rel = relative(resolve(destination), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Public asset path escaped staging');
    if (await access(target).then(() => true, () => false)) continue;
    const gitPath = `classic/apps/web/public/${asset.path.replaceAll('\\', '/')}`;
    const bytes = execFileSync('git', ['show', `${commit}:${gitPath}`], { cwd: repository, maxBuffer: 128 * 1024 ** 2, windowsHide: true });
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw Error(`Pinned public asset failed verification: ${asset.path}`);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    restored.push({ path: asset.path, sha256: asset.sha256, commit });
  }
  return restored;
}
