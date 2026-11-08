import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const executableName = name => process.platform === 'win32' ? `${name}.exe` : name;
export function openLocalTarget(target) {
  const command = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const child = spawn(command, [target], { stdio: 'ignore', windowsHide: true });
  child.on('error', error => console.error('Could not open local production:', error.code || error.name));
  child.unref();
}
