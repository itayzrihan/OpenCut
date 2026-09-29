// Run an immutable browser build and its tailnet adapter under one local host.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!config.appRoot || !config.accountsRoot || !config.publicOrigin) throw Error('Deployment config required');
const children = new Set();
let stopping = false;
function supervise(file, cwd, environment) {
  if (stopping) return;
  const child = spawn(process.execPath, [file], { cwd, windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production', ...environment }, stdio: 'inherit' });
  children.add(child);
  child.on('error', error => console.error(new Date().toISOString(), error.message));
  child.on('exit', code => {
    children.delete(child);
    if (!stopping) {
      console.error(new Date().toISOString(), `${file} exited (${code}); restarting in 5 seconds`);
      setTimeout(() => supervise(file, cwd, environment), 5000);
    }
  });
}
supervise(join(config.appRoot, 'server.js'), config.appRoot, {
  PORT: String(config.appPort || 3110), HOSTNAME: '127.0.0.1',
  OPENCUT_ACCOUNTS_DIR: config.accountsRoot,
});
supervise(join(dirname(fileURLToPath(import.meta.url)), 'tailnet-gateway.mjs'), config.appRoot, {
  OPENCUT_PUBLIC_ORIGIN: config.publicOrigin,
  OPENCUT_BACKEND_ORIGIN: `http://127.0.0.1:${config.appPort || 3110}`,
  OPENCUT_GATEWAY_PORT: String(config.gatewayPort || 3111),
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  for (const child of children) child.kill();
});
