import fs from 'node:fs';

// Bumped when the viewer assets change; busts the ?v= cache and reported in
// /health so the `site compare` wrapper knows when to restart the server.
export const VIEWER_VERSION = 28;

function readAsset(path) {
  try {
    return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

// Loaded once at startup — the viewer is static; only the config blob is per-run.
export const assets = {
  html: readAsset('../assets/viewer.html'),
  css: readAsset('../assets/viewer.css'),
  js: readAsset('../assets/viewer.js'),
  icon: readAsset('../assets/icon.svg'),
};

export function renderViewer({ devBase, liveBase, brand, author, vaultDir }, session) {
  const config = JSON.stringify({
    dev: devBase.href.replace(/\/$/, ''),
    live: liveBase.href.replace(/\/$/, ''),
    brand,
    author,
    vault: !!vaultDir,
    token: session.token,
    api: '/api/v1',
    frameOrigins: session.frameUrls,
  }).replace(/</g, '\\u003c');

  return assets.html
    .replaceAll('__VERSION__', String(VIEWER_VERSION))
    .replace('__CONFIG__', config);
}
