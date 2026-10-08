import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

import { checkNonce } from './frame-content.ts';
import type { Side, ViewerConfig } from './wire.ts';

// Bumped when the viewer assets change; busts the ?v= cache and reported in
// /health so the `site compare` wrapper knows when to restart the server.
export const VIEWER_VERSION = 36;

function readAsset(path: string): string {
  try {
    return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch (error) {
    throw new Error(`sitedrift is missing ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run from source (tests, `node src/sitedrift.ts`), the two browser scripts are
// the TypeScript files with their types stripped. The published package ships
// them compiled under dist/assets, so nothing is stripped at runtime there.
const fromSource = import.meta.url.endsWith('.ts');

function readBrowserScript(name: 'viewer' | 'bridge'): string {
  if (!fromSource) return readAsset(`./assets/${name}.js`);
  const { emitWarning } = process;
  process.emitWarning = () => {};
  try {
    return stripTypeScriptTypes(readAsset(`../browser/${name}.ts`));
  } finally {
    process.emitWarning = emitWarning;
  }
}

export interface ViewerAssets {
  html: string;
  css: string;
  js: string;
  bridge: string;
  icon: string;
}

// Loaded once at startup. The viewer is static; only the config blob is per-run.
export const assets: ViewerAssets = {
  html: readAsset('../assets/viewer.html'),
  css: readAsset('../assets/viewer.css'),
  js: readBrowserScript('viewer'),
  bridge: readBrowserScript('bridge'),
  icon: readAsset('../assets/icon.svg'),
};

/**
 * JSON for a <script type="application/json"> block. Escaping "<" keeps the
 * payload from closing the element.
 */
function configJson(value: ViewerConfig): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Stamps a nonce on every script, style, and stylesheet link the viewer writes. */
function stamp(html: string, nonce: string): string {
  if (!nonce) return html;
  return html.replace(/<(script|style)\b|<link rel="stylesheet"/g, (tag) => `${tag} nonce="${nonce}"`);
}

export function renderViewer(
  { devBase, liveBase, brand, author, vaultDir }: { devBase: URL; liveBase: URL; brand: string; author: string; vaultDir: string },
  session: { token: string; frameUrls: Record<Side, string> },
): string {
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

export function renderHostedViewer({ live, brand = '', initialPath = '/', nonce = '' }: {
  live: string;
  brand?: string;
  initialPath?: string;
  nonce?: string;
}): string {
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
