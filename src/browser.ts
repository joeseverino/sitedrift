import { spawn } from 'node:child_process';

function openerFor(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
}

/** Opens `url` in the default browser. `command` overrides the platform's opener. */
export function openBrowser(url: string, command = openerFor(process.platform)): void {
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    // A missing opener (no xdg-open) reports through 'error', not a throw. Unhandled, it would crash the server.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is already printed.
  }
}
