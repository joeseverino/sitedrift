import fs from 'node:fs';
import path from 'node:path';

import { VIEWER_MARKER, checkNonce } from './frame-content.ts';
import { assets, renderHostedViewer } from './viewer.ts';

// Error pages stay as built: the platform serves the nearest 404.html for a
// missing route, and a wrapped one would nest the viewer inside a frame.
const ERROR_PAGE = '404.html';

function htmlFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!['__sitedrift', '__sitedrift_source'].includes(entry.name)) found.push(...htmlFiles(file));
    } else if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== ERROR_PAGE) {
      found.push(file);
    }
  }
  return found;
}

// Common static-build output directories, in priority order.
const OUTPUT_DIRS = ['dist', '_site', 'build', 'public', 'out', '.output/public', '.vercel/output/static'];

function detectOutputDir(cwd = process.cwd()): string {
  for (const name of OUTPUT_DIRS) {
    if (fs.existsSync(path.join(cwd, name))) return name;
  }
  return '';
}

function routeFor(relative: string): string {
  const file = relative.split(path.sep).join('/');
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file.slice(0, -'.html'.length)}`;
}

function secureLive(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('--live must use HTTPS.');
  }
  if (url.username || url.password) throw new Error('--live must not contain credentials.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** Which hosted platform is building, and on which branch. */
export function detectBuild(env: Record<string, string | undefined>): { platform: 'pages' | 'workers' | ''; branch: string } {
  if (env.CF_PAGES === '1') return { platform: 'pages', branch: env.CF_PAGES_BRANCH || '' };
  if (env.WORKERS_CI === '1') return { platform: 'workers', branch: env.WORKERS_CI_BRANCH || '' };
  return { platform: '', branch: '' };
}

export interface InstallOptions {
  /** Build output directory. Auto-detected (dist, _site, build, public, out, ...) when omitted. */
  dir?: string;
  /** Production origin. HTTPS, or a loopback origin for testing. */
  live: string;
  /** Strip "| <brand>" from page titles in the viewer. */
  brand?: string;
  /** Branch whose builds are left untouched. Default "main". */
  productionBranch?: string;
  /** CSP nonce or placeholder stamped on every tag sitedrift writes. */
  nonce?: string;
  /** Build environment. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Wrap even outside a Cloudflare preview build. */
  force?: boolean;
}

export type InstallResult =
  | { installed: true; branch: string; files: number }
  | { installed: false; reason: string };

/**
 * Wraps a static build for a hosted preview. Leaves production builds and
 * local builds untouched unless `force` is set. Safe to run again on the same
 * output: pages that are already wrapped are left alone.
 */
export function installCloudflarePreview({
  dir,
  live,
  brand = '',
  productionBranch = 'main',
  nonce = '',
  env = process.env,
  force = false,
}: InstallOptions): InstallResult {
  const { platform, branch } = detectBuild(env);
  if (!force && (!platform || !branch || branch === productionBranch)) {
    return { installed: false, reason: branch && branch === productionBranch ? 'production branch' : 'not a Cloudflare preview build' };
  }

  const checkedNonce = checkNonce(nonce);
  const resolvedDir = dir || detectOutputDir() || 'dist';
  const output = path.resolve(resolvedDir);
  if (!fs.existsSync(output)) throw new Error(`Build output does not exist: ${output}`);
  const files = htmlFiles(output);
  if (!files.length) throw new Error(`No HTML files found in ${output}`);

  const liveUrl = secureLive(live);
  const internal = path.join(output, '__sitedrift');
  const source = path.join(output, '__sitedrift_source');
  const assetDir = path.join(internal, 'assets');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });

  for (const file of files) {
    // The source copy must stay the original page, so a page wrapped by an
    // earlier run is never copied over it.
    if (fs.readFileSync(file, 'utf8').includes(VIEWER_MARKER)) continue;
    const relative = path.relative(output, file);
    const preserved = path.join(source, `${relative}.txt`);
    fs.mkdirSync(path.dirname(preserved), { recursive: true });
    fs.copyFileSync(file, preserved);
    fs.writeFileSync(file, renderHostedViewer({
      live: liveUrl,
      brand,
      initialPath: routeFor(relative),
      nonce: checkedNonce,
    }));
  }

  fs.writeFileSync(path.join(assetDir, 'viewer.css'), assets.css);
  fs.writeFileSync(path.join(assetDir, 'viewer.js'), assets.js);
  fs.writeFileSync(path.join(assetDir, 'bridge.js'), assets.bridge);
  fs.writeFileSync(path.join(assetDir, 'icon.svg'), assets.icon);
  const config: Record<string, string> = { live: liveUrl, productionBranch };
  if (checkedNonce) config.nonce = checkedNonce;
  fs.writeFileSync(path.join(internal, 'config.json'), JSON.stringify(config));
  return { installed: true, branch: branch || 'forced', files: files.length };
}

export const FUNCTION_SOURCE = "export { onRequest } from 'sitedrift/cloudflare';\n";

/** Writes the scoped Pages Function and returns the build line to add. Idempotent. */
export function scaffoldCloudflarePreview({ cwd = process.cwd(), js = false, live = '', dir = '' }: {
  cwd?: string;
  js?: boolean;
  live?: string;
  dir?: string;
} = {}): { created: boolean; functionFile: string; outDir: string; buildLine: string } {
  const ext = js ? 'js' : 'ts';
  const functionDir = path.join(cwd, 'functions', '__sitedrift');
  const functionFile = path.join(functionDir, `[[path]].${ext}`);
  const created = !fs.existsSync(functionFile);
  if (created) {
    fs.mkdirSync(functionDir, { recursive: true });
    fs.writeFileSync(functionFile, FUNCTION_SOURCE);
  }
  const outDir = dir || detectOutputDir(cwd) || 'dist';
  const liveArg = live || 'https://your-production-site.example';
  return {
    created,
    functionFile: path.relative(cwd, functionFile),
    outDir,
    buildLine: `sitedrift cloudflare --dir ${outDir} --live ${liveArg}`,
  };
}
