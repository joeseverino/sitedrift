// Build the publishable package into dist/: compiled JS and declarations from
// the TypeScript sources, plus the two browser scripts the viewer serves.
//
// The sources import each other as `.ts` so Node runs them unbuilt in this repo;
// tsc rewrites those specifiers in the emitted JS but leaves them in the
// declarations, where a consumer could not resolve them. Rewrite them here.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

rmSync(dist, { recursive: true, force: true });
execFileSync(tsc, ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });

for (const name of readdirSync(dist).filter((file) => file.endsWith('.d.ts'))) {
  const file = path.join(dist, name);
  const source = readFileSync(file, 'utf8');
  const rewritten = source.replace(/(['"]\.[^'"]*)\.ts(['"])/g, '$1.js$2');
  if (rewritten !== source) writeFileSync(file, rewritten);
}

// The viewer and bridge run in the browser, so they compile on their own
// settings (DOM types, classic scripts). The server reads them from dist/assets.
const scratch = path.join(dist, '.browser');
execFileSync(tsc, ['-p', 'tsconfig.build.browser.json'], { cwd: root, stdio: 'inherit' });
mkdirSync(path.join(dist, 'assets'), { recursive: true });
for (const name of ['viewer.js', 'bridge.js']) {
  cpSync(path.join(scratch, 'browser', name), path.join(dist, 'assets', name));
}
rmSync(scratch, { recursive: true, force: true });

for (const bin of ['sitedrift', 'sitedrift-mcp']) {
  // The bin entries have no exports, so their declarations are empty.
  rmSync(path.join(dist, `${bin}.d.ts`));
  chmodSync(path.join(dist, `${bin}.js`), 0o755);
}
