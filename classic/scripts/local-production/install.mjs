import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { classicRoot, deploymentRoot, configPath, readJson, writeJson } from './common.mjs';

if (!['darwin', 'win32'].includes(process.platform)) throw Error('This installer supports macOS and Windows.');
await mkdir(deploymentRoot, { recursive: true, mode: 0o700 });
const previous = await readJson(configPath);
const config = previous ?? {
  node: process.execPath,
  bun: execFileSync(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', [process.platform === 'win32' ? 'bun.exe' : 'bun'], { windowsHide: true }).toString().trim().split(/\r?\n/)[0],
  path: process.env.PATH,
  accountsRoot: process.env.OPENCUT_ACCOUNTS_DIR || join(homedir(), 'Movies', 'OpenCut Accounts'),
  panelPort: 3210,
  appPort: 3211,
};
await writeJson(configPath, config);
try {
  await writeFile(join(deploymentRoot, 'runtime.env'), await readFile(join(classicRoot, 'apps/web/.env.local')), { flag: 'wx', mode: 0o600 });
} catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
if (process.platform === 'win32') {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const launcher = join(deploymentRoot, 'OpenCut Local.ps1');
  await writeFile(launcher, `$env:OPENCUT_LOCAL_DEPLOYMENT_DIR=${quote(deploymentRoot)}\n& ${quote(config.node)} ${quote(join(classicRoot, 'scripts/local-production/launch.mjs'))}\n`, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  console.log(`Installed browser production launcher: ${launcher}\nProduction data: ${deploymentRoot}\nAccounts: ${config.accountsRoot}`);
} else {
const app = join(homedir(), 'Desktop', 'OpenCut Local.app');
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await mkdir(join(app, 'Contents/Resources'), { recursive: true });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(app, 'Contents/MacOS/OpenCutLocal'),
  `#!/bin/sh\nexport OPENCUT_LOCAL_DEPLOYMENT_DIR=${quote(deploymentRoot)}\nexec ${quote(config.node)} ${quote(join(classicRoot, 'scripts/local-production/launch.mjs'))}\n`, { mode: 0o755 });
await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>OpenCut Local</string>
<key>CFBundleDisplayName</key><string>OpenCut Local</string>
<key>CFBundleIdentifier</key><string>com.opencut.local-launcher</string>
<key>CFBundleExecutable</key><string>OpenCutLocal</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>`);
console.log(`Installed ${app}\nProduction data: ${deploymentRoot}\nAccounts: ${config.accountsRoot}`);
}
