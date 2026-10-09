import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

export const classicRoot = resolve(import.meta.dirname, '../..');
export const repository = resolve(classicRoot, '..');
export const deploymentRoot = process.env.OPENCUT_LOCAL_DEPLOYMENT_DIR ||
  join(homedir(), 'Library', 'Application Support', 'OpenCut Local');
export const configPath = join(deploymentRoot, 'config.json');
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
export async function configuration() {
  await mkdir(deploymentRoot, { recursive: true, mode: 0o700 });
  const config = await readJson(configPath);
  if (!config) throw Error('Run node classic/scripts/local-production/install.mjs first.');
  return config;
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runtimeEnvironment(config) {
  let configured = {};
  try { configured = parseEnv(await readFile(join(deploymentRoot, 'runtime.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Local Production is always loopback-only, even if development used a proxy.
  const environment = { ...process.env, ...configured, PATH: config.path, NODE_ENV: 'production',
    NEXT_PUBLIC_SITE_URL: `http://localhost:${config.appPort}`, NEXT_TELEMETRY_DISABLED: '1',
    OPENCUT_ACCOUNTS_DIR: config.accountsRoot };
  delete environment.OPENCUT_PUBLIC_ORIGIN;
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}
