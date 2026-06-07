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

  const output = path.resolve(dir);
  if (!fs.existsSync(output)) throw new Error(`Build output does not exist: ${output}`);
  const files = htmlFiles(output);
  if (!files.length) throw new Error(`No HTML files found in ${output}`);

  const liveUrl = secureLive(live);
  const internal = path.join(output, '__sitedrift');
  const source = path.join(internal, 'source');
  const assetDir = path.join(internal, 'assets');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });

  for (const file of files) {
    const relative = path.relative(output, file);
    const preserved = path.join(source, relative);
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
