import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { configuration, deploymentRoot, readJson, delay, runtimeEnvironment } from './common.mjs';

const config = await configuration();
const origin = `http://127.0.0.1:${config.panelPort}`;
const appUrl = `http://localhost:${config.appPort}/projects`;
const token = randomBytes(32).toString('hex');
let production = null, electron = null, builder = null, controlPlane = null, busy = false, lastSeen = Date.now(), error = null;
let activeRelease = null;
const expectedExits = new WeakSet();
await mkdir(join(deploymentRoot, 'logs'), { recursive: true });
async function child(command, args, options, logName) {
  const log = await open(join(deploymentRoot, 'logs', logName), 'a', 0o600);
  try {
    const process = spawn(command, args, { ...options, stdio: [options?.keepStdin ? 'pipe' : 'ignore', log.fd, log.fd] });
    await once(process, 'spawn');
    return process;
  } finally { await log.close(); }
}
async function stopChild(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  expectedExits.add(process);
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function assertFreePort(port) {
  const probe = netServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function start() {
  if (production) return;
  if (builder) throw Error('Wait for the production update to finish.');
  const release = await readJson(join(deploymentRoot, 'current.json'));
  if (!release) throw Error('Build production first using the update button.');
  await assertFreePort(config.appPort);
  const process = await child(config.node, [join(release.appRoot, 'server.js')], {
    cwd: release.appRoot,
    env: { ...await runtimeEnvironment(config), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      HOSTNAME: '127.0.0.1', PORT: String(config.appPort), OPENCUT_ACCOUNTS_DIR: config.accountsRoot },
  }, 'production.log');
  production = process;
  activeRelease = release;
  process.once('exit', (code) => {
    if (production === process) { production = null; activeRelease = null; }
    if (code && !expectedExits.has(process)) error = `Production stopped (${code}). See production.log.`;
    // A crashed web process must not leave its companion processes running.
    void stopChild(controlPlane);
    void stopChild(electron);
  });
  try {
    for (let i = 0; i < 120; i++) {
      if (process.exitCode !== null) throw Error('Production exited during startup.');
      try {
        const r = await fetch(`http://127.0.0.1:${config.appPort}/`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          controlPlane = await child(join(deploymentRoot, 'releases', release.id, 'opencut-mcp'), [], {
            cwd: release.appRoot, keepStdin: true, env: { ...globalThis.process.env, PATH: config.path },
          }, 'control-plane.log');
          // This is a launcher-owned process. External MCP instances are untouched.
          controlPlane.once('exit', () => { controlPlane = null; });
          return;
        }
      } catch {}
      await delay(250);
    }
    throw Error('Production startup timed out. See production.log.');
  } catch (e) { await stopChild(process); throw e; }
}
async function stop() {
  await stopChild(electron); electron = null;
  await stopChild(production); production = null; activeRelease = null;
  await stopChild(controlPlane); controlPlane = null;
}
async function openElectron() {
  await start();
  if (electron) return;
  const releaseRoot = join(deploymentRoot, 'releases', activeRelease.id);
  await mkdir(join(deploymentRoot, 'electron-profile'), { recursive: true, mode: 0o700 });
  const process = await child(join(releaseRoot, 'Electron.app/Contents/MacOS/Electron'), [join(releaseRoot, 'electron')], {
    env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: undefined, PATH: config.path, NODE_ENV: 'production',
      OPENCUT_ELECTRON_URL: appUrl, OPENCUT_ELECTRON_USER_DATA: join(deploymentRoot, 'electron-profile'),
      OPENCUT_ELECTRON_EXIT_ON_CLOSE: '1' },
  }, 'electron.log');
  electron = process;
  process.once('exit', () => { if (electron === process) electron = null; });
}
async function update() {
  if (production || electron) throw Error('Stop production before updating.');
  if (builder) throw Error('An update is already running.');
  const process = await child(config.node, [join(import.meta.dirname, 'build.mjs')], {
    env: { ...globalThis.process.env, PATH: config.path },
  }, 'build.log');
  builder = process;
  process.once('exit', code => { builder = null; if (code) error = 'Production update failed; the previous release is preserved. Open the build log.'; });
}
function authorized(request) {
  if (request.headers.origin && request.headers.origin !== origin) return false;
  const supplied = Buffer.from(request.headers['x-opencut-launcher'] || '');
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
const server = createServer(async (request, response) => {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.headers.host !== `127.0.0.1:${config.panelPort}`) return json(response, { error: 'Invalid host' }, 403);
  if (request.headers.origin && request.headers.origin !== origin) return json(response, { error: 'Invalid origin' }, 403);
  const path = new URL(request.url, origin).pathname;
  try {
    if (request.method === 'GET' && path === '/health') return json(response, { service: 'opencut-local-launcher' });
    if (request.method === 'GET' && path === '/') {
      lastSeen = Date.now();
      const html = (await readFile(join(import.meta.dirname, 'panel.html'), 'utf8')).replaceAll('__LAUNCHER_TOKEN__', token);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
      return response.end(html);
    }
    if (!authorized(request)) return json(response, { error: 'Unauthorized' }, 403);
    if (request.method === 'GET' && path === '/status') {
      lastSeen = Date.now();
      const build = await readJson(join(deploymentRoot, 'build.json'));
      const buildLock = await readJson(join(deploymentRoot, 'build.lock'));
      let externalBuild = false;
      if (buildLock) { try { process.kill(buildLock.pid, 0); externalBuild = true; } catch {} }
      return json(response, { running: !!production, electron: !!electron, building: !!builder || externalBuild, busy, error, appUrl,
        release: activeRelease ?? await readJson(join(deploymentRoot, 'current.json')), build });
    }
    if (request.method !== 'POST') return json(response, { error: 'Not found' }, 404);
    if (busy) return json(response, { error: 'An action is already running' }, 409);
    const actions = {
      '/start': start, '/stop': stop, '/electron': openElectron, '/update': update,
      '/browser': async () => { await start(); spawn('/usr/bin/open', [appUrl], { stdio: 'ignore' }).unref(); },
      '/logs': async () => { spawn('/usr/bin/open', [join(deploymentRoot, 'logs')], { stdio: 'ignore' }).unref(); },
      '/quit': async () => { if (production || builder || electron) throw Error('Stop production and wait for updates before closing the panel.'); setTimeout(() => server.close(), 100); },
    };
    if (!Object.hasOwn(actions, path)) return json(response, { error: 'Unknown action' }, 404);
    busy = true; error = null;
    try { await actions[path](); json(response, { ok: true }); }
    finally { busy = false; }
  } catch (e) { error = e.message; json(response, { error }, 400); }
});
server.listen(config.panelPort, '127.0.0.1');
server.on('error', e => { console.error(e); process.exitCode = 1; });
// No login item or launch daemon. A stopped, abandoned panel exits by itself.
const idle = setInterval(() => {
  if (!production && !builder && !busy && Date.now() - lastSeen > 120000) server.close();
}, 10000);
idle.unref();
server.on('close', () => clearInterval(idle));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await stopChild(builder); await stop(); server.close();
});
