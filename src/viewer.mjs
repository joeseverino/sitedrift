import fs from 'node:fs';

import { checkNonce } from './frame-content.mjs';

// Bumped when the viewer assets change; busts the ?v= cache and reported in
// /health so the `site compare` wrapper knows when to restart the server.
export const VIEWER_VERSION = 35;

/** @param {string} path */
function readAsset(path) {
  try {
    return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

// Loaded once at startup. The viewer is static; only the config blob is per-run.
export const assets = {
  html: readAsset('../assets/viewer.html'),
  css: readAsset('../assets/viewer.css'),
  js: readAsset('../assets/viewer.js'),
  bridge: readAsset('../assets/bridge.js'),
  icon: readAsset('../assets/icon.svg'),
};

/**
 * JSON for a <script type="application/json"> block. Escaping "<" keeps the
 * payload from closing the element.
 * @param {unknown} value
 */
function configJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Stamps a nonce on every script, style, and stylesheet link the viewer writes.
 * @param {string} html
 * @param {string} nonce
 */
function stamp(html, nonce) {
  if (!nonce) return html;
  return html.replace(/<(script|style)\b|<link rel="stylesheet"/g, (tag) => `${tag} nonce="${nonce}"`);
}

/**
 * @param {{ devBase: URL, liveBase: URL, brand: string, author: string, vaultDir: string }} config
 * @param {{ token: string, frameUrls: Record<string, string> }} session
 */
export function renderViewer({ devBase, liveBase, brand, author, vaultDir }, session) {
  const config = configJson({
    dev: devBase.href.replace(/\/$/, ''),
    live: liveBase.href.replace(/\/$/, ''),
    brand,
    author,
    vault: !!vaultDir,
    token: session.token,
    api: '/api/v1',
    frameOrigins: session.frameUrls,
    hosted: false,
  });

  return assets.html
    .replaceAll('__VERSION__', String(VIEWER_VERSION))
    .replace('__CONFIG__', () => config);
}

/**
 * @param {{ live: string, brand?: string, initialPath?: string, nonce?: string }} options
 */
export function renderHostedViewer({ live, brand = '', initialPath = '/', nonce = '' }) {
  const config = configJson({
    dev: '',
    live,
    brand,
    author: 'you',
    vault: false,
    token: '',
    api: '',
    frameOrigins: { dev: '', live: '' },
    hosted: true,
    localNotes: true,
    initialPath,
  });

  const html = assets.html
    .replaceAll('/icon.svg', '/__sitedrift/assets/icon.svg')
    .replaceAll('/viewer.css', '/__sitedrift/assets/viewer.css')
    .replaceAll('/viewer.js', '/__sitedrift/assets/viewer.js')
    .replaceAll('__VERSION__', String(VIEWER_VERSION))
    .replace('__CONFIG__', () => config);
  return stamp(html, checkNonce(nonce));
}
