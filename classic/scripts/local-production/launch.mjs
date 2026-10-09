import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration, deploymentRoot, delay } from './common.mjs';

const config = await configuration();
const origin = `http://127.0.0.1:${config.panelPort}`;
async function ready() {
  try {
    const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
    return r.ok && (await r.json()).service === 'opencut-local-launcher';
  } catch { return false; }
}
if (!await ready()) {
  await mkdir(join(deploymentRoot, 'logs'), { recursive: true });
  const log = await open(join(deploymentRoot, 'logs/launcher.log'), 'a', 0o600);
  const child = spawn(config.node, [join(import.meta.dirname, 'server.mjs')], {
    detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PATH: config.path },
  });
  child.unref();
  await log.close();
  for (let i = 0; i < 80 && !await ready(); i++) await delay(100);
  if (!await ready()) throw Error(`Local control panel failed to start. See ${deploymentRoot}/logs/launcher.log`);
}
spawn('/usr/bin/open', [origin], { stdio: 'ignore' }).unref();
