import fs from 'node:fs';
import path from 'node:path';

import { assets, renderHostedViewer } from './viewer.mjs';

function htmlFiles(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__sitedrift') found.push(...htmlFiles(file));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      found.push(file);
    }
  }
  return found;
}

// Common static-build output directories, in priority order. Used to spare the
// user from having to know (or mistype) their framework's output path.
const OUTPUT_DIRS = ['dist', '_site', 'build', 'public', 'out', '.output/public', '.vercel/output/static'];

function detectOutputDir(cwd = process.cwd()) {
  for (const name of OUTPUT_DIRS) {
    if (fs.existsSync(path.join(cwd, name))) return name;
  }
  return '';
}

function routeFor(relative) {
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`;
  return `/${relative.slice(0, -'.html'.length)}`;
}

function secureLive(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('--live must use HTTPS.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

export function installCloudflarePreview({
  dir,
  live,
  brand = '',
  productionBranch = 'main',
  env = process.env,
  force = false,
}) {
  const branch = env.CF_PAGES_BRANCH || '';
  if (!force && (env.CF_PAGES !== '1' || !branch || branch === productionBranch)) {
    return { installed: false, reason: branch === productionBranch ? 'production branch' : 'not a Pages preview' };
  }

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
    }));
  }

  fs.writeFileSync(path.join(assetDir, 'viewer.css'), assets.css);
  fs.writeFileSync(path.join(assetDir, 'viewer.js'), assets.js);
  fs.writeFileSync(path.join(assetDir, 'icon.svg'), assets.icon);
  fs.writeFileSync(path.join(internal, 'config.json'), JSON.stringify({ live: liveUrl }));
  return { installed: true, branch: branch || 'forced', files: files.length };
}

// One-shot scaffolder: writes the scoped Pages Function so the user never has to
// hand-create it, and returns the exact build line to add. Idempotent.
export function scaffoldCloudflarePreview({ cwd = process.cwd(), js = false, live = '', dir = '' } = {}) {
  const ext = js ? 'js' : 'ts';
  const functionDir = path.join(cwd, 'functions', '__sitedrift');
  const functionFile = path.join(functionDir, `[[path]].${ext}`);
  const created = !fs.existsSync(functionFile);
  if (created) {
    fs.mkdirSync(functionDir, { recursive: true });
    fs.writeFileSync(functionFile, "export { onRequest } from 'sitedrift/cloudflare';\n");
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
