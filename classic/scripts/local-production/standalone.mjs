import { cp, mkdir, readdir, lstat, stat, realpath, symlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

/** Keep Bun's package topology while rebasing Windows junctions into the release. */
export async function copyStandalone({ source, destination, tracingRoot, platform = process.platform }) {
  if (platform !== 'win32') {
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    return;
  }
  const input = await realpath(source), output = resolve(destination), workspace = await realpath(tracingRoot);
  const outputRelative = relative(input, output);
  if (!outputRelative || (!outputRelative.startsWith('..') && !isAbsolute(outputRelative)))
    throw Error('Standalone destination must be outside its input');
  const links = [];
  async function copyDirectory(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const original = join(from, entry.name), target = join(to, entry.name);
      const info = await lstat(original);
      if (info.isSymbolicLink()) {
        const actual = await realpath(original);
        if ((await stat(actual)).isDirectory()) {
          const insideInput = relative(input, actual);
          const path = insideInput && !insideInput.startsWith('..') && !isAbsolute(insideInput)
            ? insideInput : relative(workspace, actual);
          if (!path || path.startsWith('..') || isAbsolute(path)) throw Error('Standalone junction escapes its tracing root');
          links.push({ target, mapped: join(output, path) });
        } else await cp(actual, target);
      } else if (info.isDirectory()) await copyDirectory(original, target);
      else await cp(original, target);
    }
  }
  await copyDirectory(input, output);
  // All traced package directories exist before junction creation. No link
  // points back into the mutable checkout or Bun's source installation.
  for (const { target, mapped } of links) {
    if (!(await stat(mapped)).isDirectory()) throw Error('Standalone junction target was not traced');
    await symlink(mapped, target, 'junction');
  }
}
