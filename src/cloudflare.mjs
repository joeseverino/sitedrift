import fs from 'node:fs';
import path from 'node:path';

import { checkNonce } from './frame-content.mjs';
import { assets, renderHostedViewer } from './viewer.mjs';

// Error pages stay as built: the platform serves the nearest 404.html for a
// missing route, and a wrapped one would nest the viewer inside a frame.
const ERROR_PAGE = '404.html';

/**
 * @param {string} root
 * @returns {string[]}
 */
function htmlFiles(root) {
  /** @type {string[]} */
  const found = [];
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

/** @param {string} [cwd] */
function detectOutputDir(cwd = process.cwd()) {
  for (const name of OUTPUT_DIRS) {
    if (fs.existsSync(path.join(cwd, name))) return name;
  }
  return '';
}

/** @param {string} relative */
function routeFor(relative) {
  const file = relative.split(path.sep).join('/');
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file.slice(0, -'.html'.length)}`;
}

/** @param {string} value */
function secureLive(value) {
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

/**
 * Which hosted platform is building, and on which branch.
 * @param {Record<string, string | undefined>} env
 * @returns {{ platform: 'pages' | 'workers' | '', branch: string }}
 */
export function detectBuild(env) {
  if (env.CF_PAGES === '1') return { platform: 'pages', branch: env.CF_PAGES_BRANCH || '' };
  if (env.WORKERS_CI === '1') return { platform: 'workers', branch: env.WORKERS_CI_BRANCH || '' };
  return { platform: '', branch: '' };
}

/**
 * Wraps a static build for a hosted preview. Leaves production builds and
 * local builds untouched unless `force` is set.
 * @param {{
 *   dir?: string,
 *   live: string,
 *   brand?: string,
 *   productionBranch?: string,
 *   nonce?: string,
 *   env?: Record<string, string | undefined>,
 *   force?: boolean,
 * }} options
 * @returns {{ installed: true, branch: string, files: number } | { installed: false, reason: string }}
 */
export function installCloudflarePreview({
  dir,
  live,
  brand = '',
  productionBranch = 'main',
  nonce = '',
  env = process.env,
  force = false,
}) {
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
  /** @type {Record<string, string>} */
  const config = { live: liveUrl, productionBranch };
  if (checkedNonce) config.nonce = checkedNonce;
  fs.writeFileSync(path.join(internal, 'config.json'), JSON.stringify(config));
  return { installed: true, branch: branch || 'forced', files: files.length };
}

export const FUNCTION_SOURCE = "export { onRequest } from 'sitedrift/cloudflare';\n";

/**
 * Writes the scoped Pages Function and returns the build line to add. Idempotent.
 * @param {{ cwd?: string, js?: boolean, live?: string, dir?: string }} [options]
 */
export function scaffoldCloudflarePreview({ cwd = process.cwd(), js = false, live = '', dir = '' } = {}) {
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
