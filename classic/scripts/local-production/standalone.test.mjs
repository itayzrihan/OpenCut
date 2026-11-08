import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, lstat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { copyStandalone } from './standalone.mjs';

test('Windows standalone rebases package junctions and preserves transitive module resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencut-standalone- space-'));
  try {
    const source = join(root, 'standalone'), workspace = join(root, 'workspace'), destination = join(root, 'release');
    for (const base of [workspace, source]) {
      await mkdir(join(base, 'node_modules/parent/node_modules'), { recursive: true });
      await mkdir(join(base, 'node_modules/dependency'), { recursive: true });
      await writeFile(join(base, 'node_modules/parent/index.js'), 'module.exports = require("dependency");');
      await writeFile(join(base, 'node_modules/dependency/index.js'), 'module.exports = 42;');
    }
    await mkdir(join(source, 'apps/web/node_modules'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(join(workspace, 'node_modules/parent'), join(source, 'apps/web/node_modules/parent'), linkType);
    await symlink(join(workspace, 'node_modules/dependency'), join(source, 'node_modules/parent/node_modules/dependency'), linkType);
    await copyStandalone({ source, destination, tracingRoot: workspace, platform: 'win32' });
    await writeFile(join(workspace, 'node_modules/dependency/index.js'), 'throw Error("live source must not be used");');
    assert.equal((await lstat(join(destination, 'apps/web/node_modules/parent'))).isSymbolicLink(), true);
    assert.equal(await realpath(join(destination, 'apps/web/node_modules/parent')), await realpath(join(destination, 'node_modules/parent')));
    assert.equal(createRequire(join(destination, 'apps/web/server.js'))('parent'), 42);
  } finally {
    const final = await realpath(root);
    const temporaryRoot = await realpath(tmpdir());
    assert(!relative(temporaryRoot, final).startsWith('..'));
    assert(/^opencut-standalone-/.test(relative(temporaryRoot, final)));
    await rm(final, { recursive: true });
  }
});
