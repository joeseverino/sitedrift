#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

// --- CLI / config -----------------------------------------------------------
// Precedence for every setting: CLI flag > SITEDRIFT_* env > SITE_COMPARE_*
// env (legacy) > built-in default.

const aliases = { d: 'dev', l: 'live', p: 'port', o: 'open', h: 'help', v: 'version' };
const booleans = new Set(['open', 'http', 'help', 'version']);

function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg[0] !== '-' || arg === '-') { positionals.push(arg); continue; }
    arg = arg.replace(/^--?/, '');
    let value;
    const eq = arg.indexOf('=');
    if (eq !== -1) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const name = aliases[arg] || arg;
    if (booleans.has(name)) { opts[name] = true; continue; }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && next[0] !== '-') { value = next; i++; }
      else value = true;
    }
    opts[name] = value;
  }
  return { opts, positionals };
}

function envVal(name) {
  const v = process.env[`SITEDRIFT_${name}`] ?? process.env[`SITE_COMPARE_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

function pick(flag, name, fallback) {
  return opts[flag] ?? envVal(name) ?? fallback;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch { return '0.0.0'; }
}

function printHelp() {
  console.log(`sitedrift — frame local dev against production, side-by-side on the same route.

Usage:
  sitedrift [path] [options]
  npx sitedrift /pricing --dev http://localhost:4321 --live https://example.com --open

Options:
  -d, --dev <url>     Left-pane (dev) origin            [default http://127.0.0.1:4321]
  -l, --live <url>    Right-pane (live) origin          [default https://example.com]
  -p, --port <n>      Listen port                       [default 4178]
      --host <addr>   Bind address                      [default 127.0.0.1]
  -o, --open          Open the viewer in your browser
      --http          Force plain HTTP (ignore --cert/--key)
      --cert <file>   TLS cert (serve HTTPS; needs --key)
      --key <file>    TLS key
      --notes <file>  Shared review-notes JSON          [default \$TMPDIR/sitedrift-notes.json]
      --brand <text>  Strip "| <text>" from pane-header titles
      --author <name> Byline for notes added in the viewer
      --vault <dir>   Enable "Send to vault" (writes review markdown here)
  -h, --help          Show this help
  -v, --version       Print version

Every option also reads SITEDRIFT_<NAME> (e.g. SITEDRIFT_DEV). Binds to
127.0.0.1 by default — it strips framing/isolation headers, so never expose it
publicly. See https://github.com/joeseverino/sitedrift`);
}

const argv = process.argv.slice(2);
const { opts, positionals } = parseArgs(argv);

if (opts.help) { printHelp(); process.exit(0); }
if (opts.version) { console.log(readVersion()); process.exit(0); }

const host = pick('host', 'HOST', '127.0.0.1');
const port = Number(pick('port', 'PORT', 4178));
const devBase = cleanBase(pick('dev', 'DEV', 'http://127.0.0.1:4321'));
const liveBase = cleanBase(pick('live', 'LIVE', 'https://example.com'));
const certFile = opts.http ? undefined : pick('cert', 'CERT', undefined);
const keyFile = opts.http ? undefined : pick('key', 'KEY', undefined);
const notesFile = pick('notes', 'NOTES', `${os.tmpdir()}/sitedrift-notes.json`);
const brand = pick('brand', 'BRAND', '');
const author = pick('author', 'AUTHOR', 'you');
const vaultDir = pick('vault', 'VAULT', '');
const initialPath = positionals[0]
  ? '/' + String(positionals[0]).replace(/^\/+/, '')
  : '';
const viewerVersion = 22;

let iconSvg = '';
try {
  iconSvg = fs.readFileSync(new URL('./assets/icon.svg', import.meta.url), 'utf8');
} catch {}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {}
}

function cleanBase(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function loadNotes() {
  try {
    const data = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    if (Array.isArray(data)) return data;
    return Array.isArray(data.notes) ? data.notes : [];
  } catch {
    return [];
  }
}

function saveNotes(notes) {
  try {
    const tmp = `${notesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
    fs.renameSync(tmp, notesFile);
  } catch {}
}

function noteId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function notesMarkdown(notes) {
  if (!notes.length) return '# sitedrift review notes\n\n_No notes yet._\n';
  const lines = ['# sitedrift review notes', ''];
  for (const note of notes) {
    const box = note.done ? '[x]' : '[ ]';
    const where = [note.route && note.route !== '/' ? note.route : '', note.side ? note.side.toUpperCase() : '']
      .filter(Boolean).join(' ');
    const tag = where ? ` _(${where})_` : '';
    lines.push(`- ${box} **${note.author || 'note'}:** ${note.text}${tag}`);
  }
  lines.push('');
  return lines.join('\n');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

function applyNoteOp(op) {
  let notes = loadNotes();
  if (op.op === 'add' && op.text) {
    const text = String(op.text).slice(0, 2000);
    const route = op.route || '/';
    const who = (op.author || author || 'note').slice(0, 24);
    const side = op.side === 'dev' || op.side === 'live' ? op.side : null;
    // Skip an identical open note so repeated `--note` seeding doesn't pile up.
    const duplicate = notes.some((note) => !note.done
      && note.text === text && note.route === route && note.author === who && note.side === side);
    if (!duplicate) {
      notes.push({ id: noteId(), text, author: who, route, side, done: false, ts: Date.now() });
    }
  } else if (op.op === 'remove') {
    notes = notes.filter((note) => note.id !== op.id);
  } else if (op.op === 'toggle') {
    notes = notes.map((note) => (note.id === op.id ? { ...note, done: !note.done } : note));
  } else if (op.op === 'clear') {
    notes = [];
  }
  saveNotes(notes);
  return notes;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function targetFor(side, pathname, search) {
  const base = side === 'dev' ? devBase : liveBase;
  const relative = pathname.replace(new RegExp(`^/__${side}`), '') || '/';
  return new URL(`${relative}${search}`, `${base.href}/`);
}

function rewriteRootPaths(body, side) {
  const prefix = `/__${side}`;
  return body
    .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}/`)
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (attribute, quote, value) => {
      const rewritten = value.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`);
      return `srcset=${quote}${rewritten}${quote}`;
    })
    .replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`)
    .replace(/(["'`])\/(@(?:id|vite|fs)\/|_astro\/)/g, `$1${prefix}/$2`);
}

async function proxy(req, res, side, requestUrl) {
  const target = targetFor(side, requestUrl.pathname, requestUrl.search);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];
  delete headers.connection;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'manual',
    });
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (![
        'content-encoding',
        'content-length',
        'content-security-policy',
        'content-security-policy-report-only',
        'cross-origin-embedder-policy',
        'cross-origin-opener-policy',
        'cross-origin-resource-policy',
        'transfer-encoding',
        'x-frame-options',
      ].includes(key)) {
        responseHeaders[key] = value;
      }
    });
    responseHeaders['cache-control'] = 'no-store';

    const location = upstream.headers.get('location');
    if (location) {
      const redirected = new URL(location, target);
      if (redirected.origin === target.origin) {
        responseHeaders.location = `/__${side}${redirected.pathname}${redirected.search}${redirected.hash}`;
      }
    }

    const type = upstream.headers.get('content-type') || '';
    // Rewrite markup/CSS/JS always; rewrite JSON only on the dev side (Vite
    // manifests) so live API payloads with path-like strings aren't corrupted.
    const rewritable = /text\/html|text\/css|javascript/.test(type)
      || (side === 'dev' && /application\/json/.test(type));
    if (rewritable) {
      const body = rewriteRootPaths(await upstream.text(), side);
      res.writeHead(upstream.status, responseHeaders);
      res.end(body);
      return;
    }

    res.writeHead(upstream.status, responseHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    send(
      res,
      502,
      `Could not load ${target.href}\n\n${error.message}\n\nStart the dev server with: site dev`,
    );
  }
}

function viewerHtml() {
  const config = JSON.stringify({
    dev: devBase.href.replace(/\/$/, ''),
    live: liveBase.href.replace(/\/$/, ''),
    brand,
    author,
    vault: !!vaultDir,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sitedrift</title>
  <link rel="icon" href="/icon.svg">
  <style>
    :root {
      color-scheme: dark;
      --split: 50%;
      --bg: #090a0c;
      --panel: #111318;
      --line: #2a2e37;
      --muted: #8b93a3;
      --text: #f5f7fa;
      --dev: #71d99e;
      --live: #86a8ff;
      --drawer: min(420px, calc(100vw - 24px));
      font: 13px/1.4 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .app { transition: padding-right .2s ease; }
    .app.drawer-dock { padding-right: var(--drawer); }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; background: var(--bg); color: var(--text); }
    button, input { font: inherit; }
    button, summary, .label, .compactbar, .divider, .mark, .pill, .icon-control {
      -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
    }
    button, summary, .open-side { -webkit-touch-callout: none; }
    button:focus, summary:focus { outline: none; }
    button:focus-visible, summary:focus-visible {
      outline: 2px solid #86a8ff; outline-offset: 2px;
    }
    .app { height: 100%; display: grid; grid-template-rows: 52px 46px minmax(0, 1fr); }
    .app.compact { grid-template-rows: 38px minmax(0, 1fr); }
    .app.compact .toolbar, .app.compact .labels { display: none; }
    .compactbar {
      display: none; min-width: 0; align-items: center; gap: 8px; padding: 3px 8px;
      background: rgba(17, 19, 24, .98); border-bottom: 1px solid var(--line);
    }
    .app.compact .compactbar { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto minmax(0, 1fr) auto; }
    .app.compact.solo .compactbar { grid-template-columns: 30px minmax(0, 1fr) auto auto; }
    .compact-side { min-width: 0; display: flex; align-items: center; gap: 6px; }
    .compact-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .caret { width: 30px !important; height: 30px !important; padding: 0 !important; font-size: 16px; }
    .caret svg { display: block; width: 14px; height: 14px; margin: auto; transition: transform .18s ease; }
    .app.compact .caret svg { transform: rotate(180deg); }
    .toolbar {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: rgba(17, 19, 24, .96); border-bottom: 1px solid var(--line);
    }
    .mark { display: flex; align-items: center; gap: 9px; margin-right: 5px; white-space: nowrap; }
    .mark-icon { display: block; width: 20px; height: 20px; border-radius: 5px; box-shadow: 0 0 16px #71d99e55; }
    .mark strong { letter-spacing: -.01em; font-size: 14px; }
    .route {
      min-width: 52px; flex: 0 1 220px; height: 34px; padding: 0 11px; color: var(--text);
      background: #090b0e; border: 1px solid var(--line); border-radius: 7px; outline: none;
      transition: flex-basis .2s ease;
    }
    .route:focus { flex-basis: min(560px, 55vw); border-color: #65718a; box-shadow: 0 0 0 3px #65718a22; }
    .toolbar-spacer { flex: 1 1 0; min-width: 0; }
    /* Only the route box (and the spacer) absorb width; controls keep their size. */
    .toolbar > .mark, .toolbar > button, .toolbar > .modes, .toolbar > .overlay-slider, .toolbar > details { flex-shrink: 0; }
    .app.drawer-dock .mark strong { display: none; }
    button {
      height: 34px; padding: 0 11px; color: #dce1e9; background: #191c22;
      border: 1px solid var(--line); border-radius: 7px; cursor: pointer;
    }
    button:hover { background: #222630; border-color: #3b414d; }
    button.active { color: #fff; background: #283044; border-color: #4f6081; }
    button.icon { width: 34px; padding: 0; font-size: 15px; }
    button.icon svg, .icon-control svg { display: block; width: 16px; height: 16px; margin: auto; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    button[data-action="notes"] .count {
      position: absolute; top: -5px; right: -5px; display: inline-grid; min-width: 16px; height: 16px; padding: 0 4px;
      place-items: center; color: #0b0d10; background: #dce1e9; border-radius: 9px; font-size: 10px; font-weight: 800;
    }
    button[data-action="notes"] { position: relative; }
    .labels {
      position: relative; z-index: 20; display: grid; grid-template-columns: var(--split) 1fr;
      background: var(--panel); border-bottom: 1px solid var(--line);
    }
    .label {
      position: relative; min-width: 0; display: flex; align-items: center; justify-content: space-between;
      gap: 12px; padding: 0 12px; border-right: 1px solid var(--line);
    }
    .label:last-child { border-right: 0; }
    .identity { min-width: 0; display: grid; grid-template-columns: auto 24px minmax(0, 1fr); align-items: center; gap: 9px; }
    .pill { font-size: 10px; font-weight: 800; letter-spacing: .11em; }
    .pill.dev { color: var(--dev); }
    .pill.live { color: var(--live); }
    .favicon { width: 24px; height: 24px; object-fit: contain; }
    .page-meta { min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
    .page-heading { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text); font-weight: 650; white-space: nowrap; }
    .origin { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); white-space: nowrap; font-size: 11px; }
    .label-actions { display: flex; align-items: center; gap: 5px; }
    .open-side { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); text-decoration: none; font-size: 12px; }
    .open-side:hover { color: var(--text); }
    .open-side svg { width: 12px; height: 12px; }
    details { position: relative; }
    summary {
      list-style: none; padding: 5px 7px; color: var(--muted); border: 1px solid transparent;
      border-radius: 6px; cursor: pointer; white-space: nowrap; user-select: none;
    }
    summary::-webkit-details-marker { display: none; }
    summary:hover, details[open] summary { color: var(--text); background: #20242b; border-color: var(--line); }
    .icon-control {
      display: grid; width: 34px; height: 34px; padding: 0; place-items: center;
      color: #dce1e9; background: #191c22; border: 1px solid var(--line); border-radius: 7px;
    }
    .settings-card {
      position: fixed; z-index: 65; top: 48px; right: 52px; width: 230px; padding: 8px;
      background: #15181e; border: 1px solid #343945; border-radius: 10px; box-shadow: 0 18px 50px #0009;
    }
    .setting-row {
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      height: 38px; padding: 0 10px; background: transparent; border-color: transparent; text-align: left;
    }
    .setting-row:hover { background: #20242b; }
    .setting-row .state { color: var(--muted); font-size: 11px; }
    .setting-row.active .state { color: var(--dev); }
    .help-card {
      position: fixed; z-index: 65; top: 48px; right: 8px; width: 300px; padding: 14px;
      background: #15181e; border: 1px solid #343945; border-radius: 10px; box-shadow: 0 18px 50px #0009;
    }
    .help-card strong { display: block; margin-bottom: 9px; }
    .help-blurb { margin: 0 0 12px; color: var(--muted); line-height: 1.5; }
    .help-blurb b { color: var(--text); font-weight: 650; }
    .help-credit {
      margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--line);
      color: var(--muted); font-size: 11px;
    }
    .help-credit a { color: var(--text); text-decoration: none; }
    .help-credit a:hover { color: var(--live); text-decoration: underline; }
    .shortcut-list { display: grid; grid-template-columns: auto 1fr; gap: 7px 12px; margin: 0; }
    .shortcut-list dt { color: #fff; font-weight: 650; }
    .shortcut-list dd { margin: 0; color: var(--muted); }
    kbd { padding: 1px 5px; color: #e8ebf0; background: #242932; border: 1px solid #3d4552; border-radius: 4px; font: 11px ui-monospace, monospace; }
    .seo-summary { display: inline-flex; align-items: center; gap: 4px; }
    .seo-summary svg { width: 11px; height: 11px; }
    .seo-flag {
      display: inline-grid; place-items: center; min-width: 15px; height: 15px; padding: 0 4px;
      border-radius: 8px; background: #e8c468; color: #0b0d10; font-size: 9px; font-weight: 800;
    }
    .seo-flag[hidden] { display: none; }
    .seo-checks { margin-top: 16px; padding-top: 13px; border-top: 1px solid #e6e8eb; }
    .seo-checks-head {
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px;
      color: #5f6368; font: 600 11px/1.2 Inter, sans-serif; letter-spacing: .06em; text-transform: uppercase;
    }
    .seo-checks-head .bad { color: #c5221f; }
    .seo-checks-head .good { color: #137333; }
    .seo-check { display: grid; grid-template-columns: 15px 1fr auto; align-items: baseline; gap: 9px; padding: 3px 0; font-size: 13px; line-height: 18px; }
    .seo-check-mark { font-weight: 800; text-align: center; }
    .seo-check.ok .seo-check-mark { color: #137333; }
    .seo-check.bad .seo-check-mark { color: #c5221f; }
    .seo-check.bad .seo-check-label { color: #c5221f; }
    .seo-check-note { color: #80868b; font-size: 11px; white-space: nowrap; }
    .seo-card {
      position: fixed; z-index: 60; top: 108px; left: 12px; width: min(520px, calc(100vw - 24px));
      max-height: calc(100vh - 128px); overflow: auto;
      padding: 18px 20px; color: #202124; background: #fff; border: 1px solid #dfe1e5;
      border-radius: 10px; box-shadow: 0 18px 55px #0007; font-family: Arial, sans-serif;
    }
    .seo-eyebrow { margin-bottom: 12px; color: #5f6368; font: 11px/1.2 Inter, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
    .seo-source { display: grid; grid-template-columns: 28px minmax(0, 1fr) 20px; align-items: center; gap: 10px; }
    .seo-favicon { width: 28px; height: 28px; padding: 4px; object-fit: contain; background: #f1f3f4; border-radius: 50%; }
    .seo-site { color: #202124; font-size: 14px; line-height: 18px; }
    .seo-url { color: #4d5156; font-size: 12px; line-height: 16px; }
    .seo-menu { color: #4d5156; font-size: 20px; line-height: 1; letter-spacing: 1px; }
    .seo-title { margin-top: 5px; color: #1a0dab; font-size: 20px; line-height: 26px; font-weight: 400; }
    .seo-description { margin-top: 3px; color: #4d5156; font-size: 14px; line-height: 22px; }
    .seo-empty { color: #b3261e; font-style: italic; }
    .stage { position: relative; display: grid; grid-template-columns: var(--split) 1fr; min-height: 0; }
    .pane { position: relative; min-width: 0; overflow: hidden; background: #fff; }
    .pane:first-child { border-right: 1px solid var(--line); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .divider {
      position: absolute; z-index: 10; top: 0; bottom: 0; left: var(--split); width: 17px;
      transform: translateX(-50%); cursor: col-resize; touch-action: none;
    }
    .divider:focus { outline: none; }
    .divider:focus-visible { outline: 2px solid #86a8ff; outline-offset: -2px; }
    .divider::before {
      content: ""; position: absolute; top: 0; bottom: 0; left: 8px; width: 1px; background: #596171;
    }
    .grip {
      position: absolute; top: 50%; left: 50%; width: 24px; height: 54px; transform: translate(-50%, -50%);
      border: 1px solid #454c59; border-radius: 12px; background: #171a20;
      box-shadow: 0 8px 30px #0008;
    }
    .grip::after {
      content: ""; position: absolute; inset: 15px 8px;
      background: repeating-linear-gradient(90deg, #788190 0 1px, transparent 1px 4px);
    }
    .dragging iframe { pointer-events: none; }
    .app.mobile .stage {
      grid-template-columns: repeat(2, minmax(320px, 390px)); justify-content: center; align-items: stretch;
      gap: 22px; overflow-x: auto; padding: 14px 22px; background: #08090b;
    }
    .app.mobile .pane { border: 1px solid #343945; border-radius: 13px; box-shadow: 0 14px 42px #0008; }
    .app.mobile .divider { display: none; }
    .app.mobile .labels { grid-template-columns: 1fr 1fr; padding-inline: max(0px, calc((100% - 802px) / 2)); }
    .app.solo .stage { grid-template-columns: minmax(0, 1fr); }
    .app.solo .labels { grid-template-columns: minmax(0, 1fr); }
    .app.solo .divider { display: none; }
    .app.solo[data-focus="dev"] [data-pane="live"],
    .app.solo[data-focus="live"] [data-pane="dev"] {
      position: absolute; inset: 0; visibility: hidden; pointer-events: none;
    }
    .app.solo[data-focus="dev"] .label[data-label="live"],
    .app.solo[data-focus="live"] .label[data-label="dev"],
    .app.solo[data-focus="dev"] [data-compact-side="live"],
    .app.solo[data-focus="live"] [data-compact-side="dev"] { display: none; }
    .app.mobile.solo .stage { grid-template-columns: minmax(320px, 390px); }
    .review-drawer {
      position: fixed; z-index: 50; top: 0; right: 0; bottom: 0; width: var(--drawer);
      display: grid; grid-template-rows: auto minmax(0, 1fr) auto; color: var(--text); background: #111318;
      border-left: 1px solid var(--line); box-shadow: -18px 0 55px #0009; transform: translateX(102%);
      transition: transform .2s ease;
    }
    .review-drawer.open { transform: translateX(0); }
    .drawer-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .drawer-head strong { flex: 1; }
    .drawer-head .icon { width: 30px !important; height: 30px !important; }
    .drawer-head .icon.active { color: #fff; background: #283044; border-color: #4f6081; }
    .drawer-head strong { font-size: 14px; }
    .note-list { margin: 0; padding: 14px 16px 14px 38px; overflow: auto; }
    .note-list li { position: relative; margin-bottom: 10px; padding: 9px 36px 9px 11px; background: #191c22; border: 1px solid var(--line); border-radius: 8px; }
    .note-list:empty::after { content: "No review notes yet."; display: block; margin-left: -22px; color: var(--muted); }
    .remove-note { position: absolute; top: 5px; right: 5px; width: 26px !important; height: 26px !important; padding: 0 !important; }
    .note-compose { display: grid; gap: 8px; padding: 14px 16px; border-top: 1px solid var(--line); }
    .note-compose textarea {
      width: 100%; min-height: 76px; resize: none; overflow-y: hidden; padding: 9px 10px; color: var(--text);
      background: #090b0e; border: 1px solid var(--line); border-radius: 7px; font: inherit;
    }
    .note-grip { height: 9px; margin: -2px 0 1px; cursor: ns-resize; touch-action: none; }
    .note-grip::before {
      content: ""; display: block; width: 34px; height: 3px; margin: 3px auto 0;
      border-radius: 2px; background: var(--line);
    }
    .note-grip:hover::before { background: var(--muted); }
    .note-input { position: relative; }
    .note-input textarea { padding-right: 44px; }
    .note-submit {
      position: absolute; right: 8px; bottom: 8px; width: 30px !important; height: 30px !important; padding: 0 !important;
    }
    .note-submit svg { display: block; width: 16px; height: 16px; margin: auto; }
    .note-actions { display: flex; gap: 8px; }
    .note-actions button { flex: 1; }
    .note-actions:empty { display: none; }
    .toast {
      position: fixed; z-index: 70; left: 50%; bottom: 18px; padding: 8px 12px; color: #fff;
      background: #252a33; border: 1px solid #414957; border-radius: 8px; box-shadow: 0 8px 28px #0008;
      opacity: 0; transform: translate(-50%, 8px); pointer-events: none; transition: .18s ease;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .hint { color: var(--muted); white-space: nowrap; font-size: 11px; }
    .status-badge {
      display: none; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px;
      font-size: 10px; font-weight: 800; letter-spacing: .04em;
    }
    .status-badge.show { display: inline-flex; }
    .status-ok { color: #0b0d10; background: var(--dev); }
    .status-warn { color: #0b0d10; background: #e8c468; }
    .status-err { color: #fff; background: #e0556b; }
    .compact-side .status-badge { height: 16px; }
    .meta-diff {
      display: none; align-items: center; height: 18px; padding: 0 7px; color: #0b0d10;
      background: #e8c468; border-radius: 6px; font-size: 10px; font-weight: 800; cursor: default;
    }
    .meta-diff.show { display: inline-flex; }
    .seo-diff { background: #fdeec9; outline: 2px solid #f0b429; outline-offset: 1px; border-radius: 3px; }
    .modes { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .modes button { height: 34px; padding: 0 12px; color: var(--muted); background: #15181e; border: 0; border-radius: 0; font-weight: 600; }
    .modes button + button { border-left: 1px solid var(--line); }
    .modes button:hover { background: #20242b; color: var(--text); }
    .modes button.active { background: #283044; color: #fff; }
    .overlay-slider { display: none; align-items: center; gap: 8px; padding: 0 2px; }
    .app.overlay .overlay-slider { display: flex; }
    .overlay-slider input[type="range"] { width: 120px; accent-color: var(--live); transition: opacity .15s ease; }
    .app.overlay.diff .overlay-slider input[type="range"] { opacity: .4; pointer-events: none; }
    .overlay-blend.active { color: #fff; background: #283044; border-color: #4f6081; }
    .compact-controls { display: flex; align-items: center; gap: 8px; justify-self: center; }
    .compactbar .modes button { height: 30px; padding: 0 9px; }
    .diff-legend {
      display: none; position: fixed; z-index: 40; left: 50%; bottom: 16px; transform: translateX(-50%);
      padding: 6px 13px; color: #cdd3dd; background: rgba(17, 19, 24, .92); border: 1px solid var(--line);
      border-radius: 999px; font-size: 11px; pointer-events: none; white-space: nowrap;
    }
    .app.overlay.diff .diff-legend { display: block; }
    .app.overlay .stage { grid-template-columns: minmax(0, 1fr); }
    .app.overlay .pane { position: absolute; inset: 0; }
    .app.overlay .pane:first-child { border-right: 0; }
    .app.overlay .overlay-top { opacity: var(--overlay, .5); }
    .app.overlay.diff .stage { background: #000; }
    .app.overlay.diff .overlay-top { opacity: 1; mix-blend-mode: difference; }
    .app.overlay .divider { display: none; }
    .app.overlay .labels { grid-template-columns: 1fr 1fr; }
    .note-list li.done { opacity: .55; }
    .note-list li.done .note-text { text-decoration: line-through; }
    .note-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .note-author {
      padding: 1px 6px; border-radius: 5px; font-size: 10px; font-weight: 800;
      letter-spacing: .05em; text-transform: uppercase;
    }
    .note-author.joe { color: #0b0d10; background: var(--live); }
    .note-author.claude { color: #0b0d10; background: #d8a0ff; }
    .note-author.other { color: #0b0d10; background: #9aa3b2; }
    .note-where { color: var(--muted); font-size: 10px; }
    .note-text { white-space: pre-wrap; word-break: break-word; }
    .note-go { cursor: pointer; }
    .note-go:hover { color: var(--live); text-decoration: underline; }
    .note-list li { padding-right: 92px; }
    .note-toggle { position: absolute; top: 5px; right: 34px; width: 26px !important; height: 26px !important; padding: 0 !important; }
    .note-copy { position: absolute; top: 5px; right: 63px; width: 26px !important; height: 26px !important; padding: 0 !important; }
    .note-copy svg { display: block; width: 14px; height: 14px; margin: auto; }
    .note-actions { flex-wrap: wrap; }
    @media (max-width: 820px) {
      .mark strong, .hint, button[data-wide] .control-label { display: none; }
      .toolbar { padding-inline: 8px; }
      .open-side { display: none; }
      .app.mobile .stage { justify-content: start; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <button class="caret" data-action="compact" title="Collapse review chrome" aria-label="Collapse review chrome">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 10 5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="mark"><img class="mark-icon" src="/icon.svg" alt="" width="20" height="20"><strong>sitedrift</strong></div>
      <input class="route" aria-label="Route" value="/" spellcheck="false">
      <button class="icon" data-action="go" title="Load route (Enter)" aria-label="Load route">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="toolbar-spacer"></span>
      <div class="modes" role="group" aria-label="View mode">
        <button data-mode="split" title="Side by side">Split</button>
        <button data-mode="solo" title="One pane (S swaps)">Solo</button>
        <button data-mode="overlay" title="Overlay the panes (O)">Overlay</button>
      </div>
      <div class="overlay-slider">
        <input type="range" min="0" max="100" value="50" aria-label="Overlay opacity">
        <button class="overlay-blend" data-action="overlay-blend" title="Difference blend (D) — changed pixels light up" aria-pressed="false">Diff</button>
      </div>
      <button class="icon" data-action="reload" title="Reload both panes (R)" aria-label="Reload both panes">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 6.5V3m0 0H12m3.5 0-2.2 2.2A6 6 0 1 0 15.8 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon" data-action="scroll" title="Toggle locked scrolling" aria-label="Toggle locked scrolling">
        <span class="sr-only" data-scroll-label>Locked scroll</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5 10 2l3 3.5M10 2v16m-3-3.5L10 18l3-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon" data-action="swap" title="Swap sides (S)" aria-label="Swap sides">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h12m-3-3 3 3-3 3M17 14H5m3 3-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <details class="settings">
        <summary class="icon-control" title="Comparison settings" aria-label="Comparison settings">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M7 10h9M4 15h12M7 3v4m6 1v4m-6 1v4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </summary>
        <div class="settings-card">
          <button class="setting-row" data-action="mobile"><span>Mobile panes</span><span class="state">Off</span></button>
          <button class="setting-row" data-action="mirror"><span>Mirror links</span><span class="state">Off</span></button>
          <button class="setting-row" data-action="scroll-mode"><span>Scroll mode</span><span class="state">Exact</span></button>
        </div>
      </details>
      <button class="icon" data-action="notes" title="Review notes" aria-label="Review notes">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h10a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 15 13.5H9L5 17v-3.5A1.5 1.5 0 0 1 3.5 12V5A1.5 1.5 0 0 1 5 3.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <span class="count">0</span>
      </button>
      <details class="help">
        <summary class="icon-control" title="Help and keyboard shortcuts" aria-label="Help and keyboard shortcuts">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.3 7.4a1.9 1.9 0 1 1 2.4 1.8c-.7.3-.9.7-.9 1.4M10 14h.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </summary>
        <div class="help-card">
          <strong>sitedrift</strong>
          <p class="help-blurb">Local dev and production, locked to the same route and scroll. Compare side&#8209;by&#8209;side, drag the divider, or <b>Overlay</b> the panes — flip overlay to <b>Diff</b> and only the pixels that changed light up.</p>
          <dl class="shortcut-list">
            <dt><kbd>O</kbd></dt><dd>Overlay on/off (restores your layout)</dd>
            <dt><kbd>D</kbd></dt><dd>Difference blend (while overlaid)</dd>
            <dt><kbd>S</kbd></dt><dd>Swap sides (flip in Solo)</dd>
            <dt><kbd>R</kbd></dt><dd>Reload both panes</dd>
            <dt><kbd>0</kbd></dt><dd>Reset divider to 50/50</dd>
            <dt><kbd>/</kbd></dt><dd>Focus the route field</dd>
            <dt><kbd>Space</kbd></dt><dd>Page down / up with Shift</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close notes &amp; popovers</dd>
          </dl>
          <div class="help-credit">Created by <a href="https://github.com/joeseverino" target="_blank" rel="noreferrer">Joe Severino</a> · <span>github.com/joeseverino</span></div>
        </div>
      </details>
    </header>
    <section class="labels">
      <div class="label" data-label="dev">
        <div class="identity">
          <span class="pill dev">DEV</span>
          <img class="favicon" alt="">
          <span class="page-meta"><span class="page-heading">Loading…</span><span class="origin"></span></span>
        </div>
        <div class="label-actions">
          <span class="status-badge" data-status></span>
          <span class="meta-diff" data-metadiff title="Title, description, or canonical differs between sides">≠ meta</span>
          <details><summary class="seo-summary">SEO<span class="seo-flag" hidden></span> <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="seo-card"></div></details>
          <a class="open-side" target="_blank" rel="noreferrer">Open <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2h5.5v5.5M10 2 4 8m-2-4v6h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        </div>
      </div>
      <div class="label" data-label="live">
        <div class="identity">
          <span class="pill live">LIVE</span>
          <img class="favicon" alt="">
          <span class="page-meta"><span class="page-heading">Loading…</span><span class="origin"></span></span>
        </div>
        <div class="label-actions">
          <span class="status-badge" data-status></span>
          <span class="meta-diff" data-metadiff title="Title, description, or canonical differs between sides">≠ meta</span>
          <details><summary class="seo-summary">SEO<span class="seo-flag" hidden></span> <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></summary><div class="seo-card"></div></details>
          <a class="open-side" target="_blank" rel="noreferrer">Open <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2h5.5v5.5M10 2 4 8m-2-4v6h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        </div>
      </div>
    </section>
    <header class="compactbar">
      <button class="caret" data-action="compact" title="Expand review chrome" aria-label="Expand review chrome">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 10 5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="compact-side" data-compact-side="dev"><span class="pill dev">DEV</span><span class="compact-title" data-compact-title="dev">Loading…</span><span class="status-badge"></span></div>
      <div class="compact-controls">
        <div class="modes" role="group" aria-label="View mode">
          <button data-mode="split">Split</button>
          <button data-mode="solo">Solo</button>
          <button data-mode="overlay">Overlay</button>
        </div>
        <div class="overlay-slider">
          <input type="range" min="0" max="100" value="50" aria-label="Overlay opacity">
          <button class="overlay-blend" data-action="overlay-blend" title="Difference blend (D)" aria-pressed="false">Diff</button>
        </div>
        <button class="icon" data-action="reload" title="Reload both panes" aria-label="Reload both panes">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 6.5V3m0 0H12m3.5 0-2.2 2.2A6 6 0 1 0 15.8 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="compact-side" data-compact-side="live"><span class="pill live">LIVE</span><span class="compact-title" data-compact-title="live">Loading…</span><span class="status-badge"></span></div>
      <button class="icon" data-action="notes" title="Review notes" aria-label="Review notes">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h10a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 15 13.5H9L5 17v-3.5A1.5 1.5 0 0 1 3.5 12V5A1.5 1.5 0 0 1 5 3.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      </button>
    </header>
    <section class="stage">
      <div class="pane" data-pane="dev"><iframe data-side="dev" title="Development site"></iframe></div>
      <div class="pane" data-pane="live"><iframe data-side="live" title="Live site"></iframe></div>
      <div class="divider" role="separator" aria-label="Resize comparison panes" aria-orientation="vertical" tabindex="0"><span class="grip"></span></div>
    </section>
    <div class="diff-legend" aria-hidden="true">Difference · lit = changed · black = identical</div>
  </main>
  <aside class="review-drawer" aria-label="Review notes">
    <div class="drawer-head">
      <strong>Review notes</strong>
      <button class="icon" data-action="notes-dock" title="Dock: push the panes aside vs float over them" aria-label="Dock notes" aria-pressed="false">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="12.5" y1="4" x2="12.5" y2="16" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
      <button class="icon" data-action="notes-close" aria-label="Close notes">×</button>
    </div>
    <ol class="note-list"></ol>
    <div class="note-compose">
      <div class="note-grip" title="Drag to resize" aria-hidden="true"></div>
      <div class="note-input">
        <textarea placeholder="Add a change, question, or thing to verify…"></textarea>
        <button class="note-submit" data-action="note-add" title="Add note (⌘↵)" aria-label="Add note">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="note-actions"><button data-action="note-vault" hidden>Send to vault</button><button data-action="note-export">Export .md</button></div>
    </div>
  </aside>
  <div class="toast" role="status"></div>
  <script>
    const config = ${config};
    const root = document.documentElement;
    const app = document.querySelector('.app');
    const routeInput = document.querySelector('.route');
    const divider = document.querySelector('.divider');
    const scrollButton = document.querySelector('[data-action="scroll"]');
    const scrollModeButton = document.querySelector('[data-action="scroll-mode"]');
    const mirrorButton = document.querySelector('[data-action="mirror"]');
    const mobileButton = document.querySelector('[data-action="mobile"]');
    const modeButtons = [...document.querySelectorAll('[data-mode]')];
    const overlaySliders = [...document.querySelectorAll('.overlay-slider input')];
    const blendButtons = [...document.querySelectorAll('[data-action="overlay-blend"]')];
    const notesDrawer = document.querySelector('.review-drawer');
    const noteList = document.querySelector('.note-list');
    const noteInput = document.querySelector('.note-compose textarea');
    const toast = document.querySelector('.toast');
    const params = new URLSearchParams(location.search);
    const attachedDocuments = new WeakSet();
    const suppressScrollUntil = { dev: 0, live: 0 };
    const scrollFrames = { dev: 0, live: 0 };
    const settleTimers = { dev: [], live: [] };
    let order = params.get('swap') === '1' ? ['live', 'dev'] : ['dev', 'live'];
    let syncScroll = queryOrStoredBool('scroll', 'site-compare-scroll', false);
    let scrollMode = params.get('scrollMode') || localStorage.getItem('site-compare-scroll-mode') || 'exact';
    if (!['exact', 'ratio'].includes(scrollMode)) scrollMode = 'exact';
    let mirrorLinks = queryOrStoredBool('mirror', 'site-compare-mirror', false);
    let mobileMode = (params.get('mode') || localStorage.getItem('site-compare-mode')) === 'mobile';
    let compactMode = queryOrStoredBool('compact', 'site-compare-compact', false);
    let viewMode = params.get('view')
      || (params.get('overlay') === '1' ? 'overlay' : params.get('solo') === '1' ? 'solo' : null)
      || localStorage.getItem('site-compare-view') || 'split';
    let overlayBlend = (params.get('overlayBlend') || localStorage.getItem('site-compare-overlay-blend')) === 'difference' ? 'difference' : 'opacity';
    if (viewMode === 'diff') { viewMode = 'overlay'; overlayBlend = 'difference'; } // back-compat
    if (!['split', 'solo', 'overlay'].includes(viewMode)) viewMode = 'split';
    let overlayAmount = Number(params.get('overlayAmount') ?? localStorage.getItem('site-compare-overlay-amount'));
    if (!Number.isFinite(overlayAmount)) overlayAmount = 50;
    let focusSide = params.get('focus') === 'live' ? 'live' : params.get('focus') === 'dev' ? 'dev' : order[0];
    let reviewNotes = [];
    let notesSignature = '';
    let notesOpen = params.get('notes') === '1';
    let dockMode = queryOrStoredBool('dock', 'site-compare-dock', true);
    let scrollOwner = null;
    const meta = { dev: null, live: null };

    function queryOrStoredBool(queryName, storageName, fallback) {
      if (params.has(queryName)) return params.get(queryName) === '1';
      const stored = localStorage.getItem(storageName);
      return stored === null ? fallback : stored === '1';
    }

    function normalizeRoute(value) {
      try {
        if (/^https?:\\/\\//.test(value)) {
          const parsed = new URL(value);
          value = parsed.pathname + parsed.search + parsed.hash;
        }
      } catch {}
      value = value.trim() || '/';
      return value.startsWith('/') ? value : '/' + value;
    }

    function frame(side) { return document.querySelector('iframe[data-side="' + side + '"]'); }
    function proxied(side, route) { return '/__' + side + normalizeRoute(route); }
    function direct(side, route) { return config[side] + normalizeRoute(route); }

    function statusBadges(side) {
      return [
        document.querySelector('.label[data-label="' + side + '"] .status-badge'),
        document.querySelector('[data-compact-side="' + side + '"] .status-badge'),
      ].filter(Boolean);
    }

    function setStatusBadge(side, status) {
      const cls = status >= 200 && status < 300 ? 'status-ok'
        : status >= 300 && status < 400 ? 'status-warn'
        : 'status-err';
      const text = status ? String(status) : 'ERR';
      for (const badge of statusBadges(side)) {
        badge.className = 'status-badge show ' + cls;
        badge.textContent = text;
      }
    }

    function clearStatusBadge(side) {
      for (const badge of statusBadges(side)) {
        badge.className = 'status-badge';
        badge.textContent = '';
      }
    }

    function fetchStatus(side, route) {
      const url = proxied(side, route);
      const read = (method) => fetch(url, { method, cache: 'no-store', redirect: 'manual' });
      read('HEAD')
        .then((res) => (res.status === 405 || res.status === 501 ? read('GET') : res))
        .then((res) => setStatusBadge(side, res.status || (res.type === 'opaqueredirect' ? 302 : 0)))
        .catch(() => setStatusBadge(side, 0));
    }

    function brandStrip(title) {
      if (!config.brand) return title;
      const escaped = config.brand.replace(/[.*+?^$()|[\\]{}\\\\]/g, '\\\\$&');
      return title.replace(new RegExp('\\\\s*[|\\u2013\\u2014-]\\\\s*' + escaped + '.*$', 'i'), '').trim();
    }

    function updateDocTitle() {
      const primary = meta[order[0]];
      document.title = primary && primary.heading ? primary.heading + ' · sitedrift' : 'sitedrift';
    }

    function renderMetaDiff() {
      const dev = meta.dev;
      const live = meta.live;
      const diffs = {
        title: !!(dev && live) && (dev.title || '') !== (live.title || ''),
        desc: !!(dev && live) && (dev.description || '') !== (live.description || ''),
        url: !!(dev && live) && (dev.canonicalPath || '') !== (live.canonicalPath || ''),
      };
      const any = diffs.title || diffs.desc || diffs.url;
      for (const chip of document.querySelectorAll('.meta-diff')) chip.classList.toggle('show', any);
      for (const side of ['dev', 'live']) {
        const card = document.querySelector('.label[data-label="' + side + '"] .seo-card');
        if (!card) continue;
        for (const key of ['title', 'desc', 'url']) {
          const el = card.querySelector('[data-seo="' + key + '"]');
          if (el) el.classList.toggle('seo-diff', diffs[key]);
        }
      }
    }

    function setUrlParam(name, value) {
      const url = new URL(location.href);
      if (value === '' || value === null || value === undefined) url.searchParams.delete(name);
      else url.searchParams.set(name, String(value));
      history.replaceState(null, '', url);
    }

    function saveBool(queryName, storageName, value) {
      localStorage.setItem(storageName, value ? '1' : '0');
      setUrlParam(queryName, value ? '1' : '0');
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[char]);
    }

    function truncate(value, max) {
      const chars = [...String(value || '')];
      return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
    }

    function crumb(value) {
      try {
        const url = new URL(value);
        const parts = url.pathname.replace(/^\\/|\\/$/g, '').split('/').filter(Boolean)
          .map((part) => decodeURIComponent(part).replaceAll('-', ' '));
        return parts.length ? url.hostname + ' › ' + parts.join(' › ') : url.hostname;
      } catch {
        return value;
      }
    }

    function seoChecks(doc) {
      const q = (selector) => doc.querySelector(selector);
      const title = (doc.title || '').trim();
      const description = q('meta[name="description"]')?.content?.trim() || '';
      const h1s = doc.querySelectorAll('h1').length;
      const imgs = [...doc.querySelectorAll('img')];
      const noAlt = imgs.filter((img) => img.getAttribute('alt') === null).length;
      const robots = (q('meta[name="robots"]')?.content || '').toLowerCase();
      return [
        { label: 'Title present', ok: !!title },
        { label: 'Title 30–60 chars', ok: title.length >= 30 && title.length <= 60, note: title.length + '' },
        { label: 'Meta description', ok: !!description },
        { label: 'Description 70–160', ok: description.length >= 70 && description.length <= 160, note: description.length + '' },
        { label: 'Exactly one H1', ok: h1s === 1, note: h1s + ' found' },
        { label: 'Canonical link', ok: !!q('link[rel="canonical"]') },
        { label: 'Viewport meta', ok: !!q('meta[name="viewport"]') },
        { label: 'html lang', ok: !!doc.documentElement.getAttribute('lang') },
        { label: 'Open Graph title', ok: !!q('meta[property="og:title"]') },
        { label: 'Open Graph image', ok: !!q('meta[property="og:image"]') },
        { label: 'Not noindex', ok: !robots.includes('noindex') },
        { label: 'Favicon', ok: !!q('link[rel~="icon"]') },
        { label: 'Images have alt', ok: noAlt === 0, note: noAlt ? noAlt + ' missing' : 'all' },
      ];
    }

    function renderMetadata(side) {
      const iframe = frame(side);
      const doc = iframe.contentDocument;
      if (!doc) return;
      const route = iframe.contentWindow.location.pathname.replace(new RegExp('^/__' + side), '') || '/';
      const label = document.querySelector('.label[data-label="' + side + '"]');
      if (!label) return;
      const title = doc.title.trim();
      const heading = brandStrip(title)
        || doc.querySelector('h1')?.textContent?.trim()
        || 'Untitled page';
      const description = doc.querySelector('meta[name="description"]')?.content?.trim() || '';
      const canonical = doc.querySelector('link[rel="canonical"]')?.href || direct(side, route);
      const siteName = doc.querySelector('meta[property="og:site_name"]')?.content?.trim()
        || config.brand
        || new URL(direct(side, route)).hostname;
      const icon = doc.querySelector('link[rel="icon"][type="image/svg+xml"]')
        || doc.querySelector('link[rel="icon"]');
      const faviconSrc = icon?.href || ('/__' + side + '/favicon.ico');
      let canonicalPath = canonical;
      try { canonicalPath = new URL(canonical).pathname; } catch {}
      meta[side] = { title, description, canonicalPath, heading };
      label.querySelector('.page-heading').textContent = heading;
      label.querySelector('.page-heading').title = title || heading;
      updateDocTitle();
      document.querySelector('[data-compact-title="' + side + '"]').textContent = heading;
      label.querySelector('.origin').textContent = config[side] + route;
      const fav = label.querySelector('.favicon');
      fav.onerror = () => { fav.onerror = null; fav.src = '/icon.svg'; };
      fav.src = faviconSrc;
      label.querySelector('.open-side').href = direct(side, route);
      label.querySelector('.seo-card').innerHTML =
        '<div class="seo-eyebrow">' + side.toUpperCase() + ' metadata preview</div>' +
        '<div class="seo-source">' +
          '<img class="seo-favicon" alt="" src="' + escapeHtml(faviconSrc) + '">' +
          '<div><div class="seo-site">' + escapeHtml(siteName) + '</div>' +
          '<div class="seo-url" data-seo="url">' + escapeHtml(crumb(canonical)) + '</div></div>' +
          '<div class="seo-menu" aria-hidden="true">⋮</div>' +
        '</div>' +
        '<div class="seo-title' + (title ? '' : ' seo-empty') + '" data-seo="title">' +
          escapeHtml(truncate(title || 'Missing page title', 62)) + '</div>' +
        '<div class="seo-description' + (description ? '' : ' seo-empty') + '" data-seo="desc">' +
          escapeHtml(truncate(description || 'Missing meta description', 158)) + '</div>' +
        seoChecksHtml(doc);
      const seoFav = label.querySelector('.seo-favicon');
      if (seoFav) seoFav.onerror = () => { seoFav.onerror = null; seoFav.src = '/icon.svg'; };
      const fails = seoChecks(doc).filter((check) => !check.ok).length;
      const flag = label.querySelector('.seo-flag');
      if (flag) {
        flag.hidden = fails === 0;
        flag.textContent = fails ? String(fails) : '';
        flag.title = fails ? fails + ' SEO check' + (fails === 1 ? '' : 's') + ' failing' : '';
      }
      renderMetaDiff();
    }

    function seoChecksHtml(doc) {
      const checks = seoChecks(doc);
      const fails = checks.filter((check) => !check.ok).length;
      const head = '<div class="seo-checks-head"><span>SEO checks</span>'
        + (fails
          ? '<span class="bad">' + fails + ' to fix</span>'
          : '<span class="good">all good</span>')
        + '</div>';
      const rows = checks.map((check) =>
        '<div class="seo-check ' + (check.ok ? 'ok' : 'bad') + '">'
        + '<span class="seo-check-mark">' + (check.ok ? '✓' : '✗') + '</span>'
        + '<span class="seo-check-label">' + escapeHtml(check.label) + '</span>'
        + (check.note ? '<span class="seo-check-note">' + escapeHtml(check.note) + '</span>' : '')
        + '</div>').join('');
      return '<div class="seo-checks">' + head + rows + '</div>';
    }

    function positionSeoCard(details) {
      const summary = details.querySelector('summary');
      const card = details.querySelector('.seo-card');
      const rect = summary.getBoundingClientRect();
      // Cap to half the viewport so the two cards can't collide, and anchor each
      // card's right edge under its SEO button so it drops within its own pane.
      const width = Math.max(260, Math.min(420, (innerWidth - 32) / 2));
      card.style.width = width + 'px';
      const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8));
      card.style.left = left + 'px';
      card.style.top = Math.min(innerHeight - 120, rect.bottom + 8) + 'px';
    }

    function googleOpen() {
      return !!document.querySelector('.label details[open]');
    }

    function setGoogleOpen(open) {
      const all = document.querySelectorAll('.label details');
      for (const details of all) {
        if (open) details.setAttribute('open', '');
        else details.removeAttribute('open');
      }
      if (open) {
        requestAnimationFrame(() => {
          for (const details of document.querySelectorAll('.label details[open]')) positionSeoCard(details);
        });
      }
    }

    function updateLabels(route) {
      for (const side of ['dev', 'live']) {
        const label = document.querySelector('.label[data-label="' + side + '"]');
        label.querySelector('.pill').className = 'pill ' + side;
        label.querySelector('.pill').textContent = side.toUpperCase();
        label.querySelector('.page-heading').textContent = 'Loading…';
        document.querySelector('[data-compact-title="' + side + '"]').textContent = 'Loading…';
        label.querySelector('.origin').textContent = config[side] + route;
        label.querySelector('.favicon').src = '/__' + side + '/favicon.ico';
        label.querySelector('.open-side').href = direct(side, route);
        meta[side] = null;
        clearStatusBadge(side);
      }
      renderMetaDiff();
    }

    function applyOrder() {
      order.forEach((side, index) => {
        const pane = document.querySelector('[data-pane="' + side + '"]');
        pane.style.order = String(index);
        pane.classList.toggle('overlay-top', index === 1);
        document.querySelector('.label[data-label="' + side + '"]').style.order = String(index);
      });
    }

    function go(value = routeInput.value) {
      const route = normalizeRoute(value);
      routeInput.value = route;
      updateLabels(route);
      frame('dev').src = proxied('dev', route);
      frame('live').src = proxied('live', route);
      const url = new URL(location.href);
      url.searchParams.set('path', route);
      history.replaceState(null, '', url);
    }

    function setSplit(percent) {
      const value = Math.max(15, Math.min(85, percent));
      root.style.setProperty('--split', value + '%');
      divider.setAttribute('aria-valuenow', String(Math.round(value)));
      localStorage.setItem('site-compare-split', String(value));
      setUrlParam('split', Math.round(value * 10) / 10);
    }

    // Overlay and diff are only legible if both panes scroll in lockstep, so
    // they force pixel-exact linked scrolling regardless of the user's toggle.
    function stacked() { return viewMode === 'overlay'; }
    function linked() { return syncScroll || stacked(); }
    function effScrollMode() { return stacked() ? 'exact' : scrollMode; }

    function scrollRoot(win) {
      return win.document.scrollingElement || win.document.documentElement;
    }

    function applyScrollPresentation(doc) {
      let style = doc.getElementById('site-compare-scroll-style');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'site-compare-scroll-style';
        doc.head.append(style);
      }
      style.textContent = linked()
        ? 'html,body{scrollbar-width:none!important;-ms-overflow-style:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}'
        : '';
    }

    function setLinkedScroll(sourceSide, requestedY) {
      const source = frame(sourceSide).contentWindow;
      const otherSide = sourceSide === 'dev' ? 'live' : 'dev';
      const other = frame(otherSide).contentWindow;
      if (!source || !other) return;
      const sourceRoot = scrollRoot(source);
      const sourceMax = Math.max(0, sourceRoot.scrollHeight - source.innerHeight);
      const sourceY = Math.max(0, Math.min(sourceMax, requestedY));
      suppressScrollUntil[sourceSide] = Date.now() + 120;
      sourceRoot.scrollTop = sourceY;
      if (effScrollMode() === 'exact') {
        const otherRoot = scrollRoot(other);
        const sharedMax = Math.min(sourceMax, Math.max(0, otherRoot.scrollHeight - other.innerHeight));
        const sharedY = Math.min(sharedMax, sourceY);
        suppressScrollUntil[otherSide] = Date.now() + 120;
        sourceRoot.scrollTop = sharedY;
        otherRoot.scrollTop = sharedY;
      } else {
        alignSide(sourceSide, otherSide);
      }
    }

    function wheelPixels(event, win) {
      if (event.deltaMode === 1) return event.deltaY * 18;
      if (event.deltaMode === 2) return event.deltaY * win.innerHeight;
      return event.deltaY;
    }

    function alignSide(sourceSide, targetSide) {
      const source = frame(sourceSide).contentWindow;
      const target = frame(targetSide).contentWindow;
      if (!source || !target) return;
      let targetY = source.scrollY;
      if (effScrollMode() === 'ratio') {
        const sourceRoot = scrollRoot(source);
        const sourceMax = Math.max(0, sourceRoot.scrollHeight - source.innerHeight);
        const ratio = sourceMax ? source.scrollY / sourceMax : 0;
        const targetRoot = scrollRoot(target);
        const targetMax = Math.max(0, targetRoot.scrollHeight - target.innerHeight);
        targetY = ratio * targetMax;
      }
      suppressScrollUntil[targetSide] = Date.now() + (effScrollMode() === 'exact' ? 120 : 600);
      scrollRoot(target).scrollTop = targetY;
    }

    function syncFrom(side, force = false) {
      const win = frame(side).contentWindow;
      if (!win || !linked() || Date.now() < suppressScrollUntil[side]) return;
      if (!scrollOwner) scrollOwner = side;
      if (!force && scrollOwner !== side) return;
      if (effScrollMode() === 'exact') {
        alignSide(side, side === 'dev' ? 'live' : 'dev');
        return;
      }
      cancelAnimationFrame(scrollFrames[side]);
      scrollFrames[side] = requestAnimationFrame(() => {
        const otherSide = side === 'dev' ? 'live' : 'dev';
        alignSide(side, otherSide);
        for (const timer of settleTimers[side]) clearTimeout(timer);
        settleTimers[side] = [80, 240].map((delay) => setTimeout(() => {
          if (scrollOwner === side) alignSide(side, otherSide);
        }, delay));
      });
    }

    function markScrollOwner(side) {
      scrollOwner = side;
    }

    function routeFromFrameUrl(side, href) {
      const url = new URL(href);
      const prefix = '/__' + side;
      const pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
      return pathname + url.search + url.hash;
    }

    function attachFrameBehavior(side) {
      const iframe = frame(side);
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc || attachedDocuments.has(doc)) return;
      attachedDocuments.add(doc);
      doc.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      doc.body?.style.setProperty('scroll-behavior', 'auto', 'important');
      applyScrollPresentation(doc);
      doc.addEventListener('wheel', (event) => {
        if (!linked() || event.deltaY === 0) return;
        event.preventDefault();
        markScrollOwner(side);
        setLinkedScroll(side, win.scrollY + wheelPixels(event, win));
      }, { passive: false, capture: true });
      doc.addEventListener('keydown', (event) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
          || event.target.isContentEditable;
        if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const key = event.key.toLowerCase();
          if (key === 'r' || key === 's' || key === '0' || key === '/' || key === 'o' || key === 'd') {
            event.preventDefault();
            if (key === 'r') document.querySelector('[data-action="reload"]').click();
            if (key === 's') document.querySelector('[data-action="swap"]').click();
            if (key === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
            if (key === 'd') {
              if (viewMode === 'overlay' && overlayBlend === 'difference') setMode('split');
              else { setMode('overlay'); setOverlayBlend('difference'); }
            }
            if (key === '0') setSplit(50);
            if (key === '/') {
              routeInput.focus();
              routeInput.select();
            }
            return;
          }
        }
        if (!linked() || event.metaKey || event.ctrlKey || event.altKey
          || typing) return;
        let next = null;
        if (event.key === 'ArrowDown') next = win.scrollY + 44;
        if (event.key === 'ArrowUp') next = win.scrollY - 44;
        if (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) next = win.scrollY + win.innerHeight * .85;
        if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) next = win.scrollY - win.innerHeight * .85;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = scrollRoot(win).scrollHeight;
        if (next === null) return;
        event.preventDefault();
        markScrollOwner(side);
        setLinkedScroll(side, next);
      }, true);
      win.addEventListener('scroll', () => syncFrom(side), { passive: true });
      for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        doc.addEventListener(eventName, () => markScrollOwner(side), { passive: true, capture: true });
      }
      doc.addEventListener('click', (event) => {
        if (!mirrorLinks || event.defaultPrevented || event.button !== 0
          || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href]');
        if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
        const url = new URL(link.href, win.location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/__' + side)) return;
        event.preventDefault();
        go(routeFromFrameUrl(side, url.href));
      }, true);
      // Clicking into a pane counts as "clicking out" of the chrome popovers.
      doc.addEventListener('pointerdown', () => {
        for (const open of document.querySelectorAll('details.settings[open], details.help[open]')) open.removeAttribute('open');
        if (googleOpen()) setGoogleOpen(false);
        if (notesOpen && !dockMode) setNotesOpen(false);
      }, { passive: true, capture: true });
    }

    for (const side of ['dev', 'live']) {
      frame(side).addEventListener('load', () => {
        try {
          attachFrameBehavior(side);
          renderMetadata(side);
          fetchStatus(side, routeFromFrameUrl(side, frame(side).contentWindow.location.href));
        } catch {}
      });
    }

    scrollButton.addEventListener('click', () => {
      syncScroll = !syncScroll;
      scrollButton.classList.toggle('active', syncScroll);
      saveBool('scroll', 'site-compare-scroll', syncScroll);
      for (const side of ['dev', 'live']) {
        const doc = frame(side).contentDocument;
        if (doc) applyScrollPresentation(doc);
      }
      renderSettings();
      if (syncScroll) syncFrom(focusSide, true);
    });
    function renderSetting(button, active, stateText) {
      button.classList.toggle('active', active);
      button.querySelector('.state').textContent = stateText;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    function renderSettings() {
      renderSetting(mobileButton, mobileMode, mobileMode ? 'On' : 'Off');
      renderSetting(mirrorButton, mirrorLinks, mirrorLinks ? 'On' : 'Off');
      renderSetting(scrollModeButton, scrollMode === 'exact', scrollMode === 'exact' ? 'Exact' : 'Proportional');
      scrollButton.title = syncScroll ? 'Locked scrolling is on' : 'Locked scrolling is off';
      scrollButton.setAttribute('aria-pressed', syncScroll ? 'true' : 'false');
    }
    function renderScrollMode() {
      document.querySelector('[data-scroll-label]').textContent =
        scrollMode === 'exact' ? 'Locked scroll' : 'Ratio scroll';
      renderSettings();
    }
    scrollModeButton.addEventListener('click', () => {
      scrollMode = scrollMode === 'exact' ? 'ratio' : 'exact';
      localStorage.setItem('site-compare-scroll-mode', scrollMode);
      setUrlParam('scrollMode', scrollMode);
      renderScrollMode();
      for (const side of ['dev', 'live']) {
        const doc = frame(side).contentDocument;
        if (doc) applyScrollPresentation(doc);
      }
      if (syncScroll) syncFrom(focusSide, true);
    });
    mirrorButton.addEventListener('click', () => {
      mirrorLinks = !mirrorLinks;
      saveBool('mirror', 'site-compare-mirror', mirrorLinks);
      renderSettings();
    });
    mobileButton.addEventListener('click', () => {
      mobileMode = !mobileMode;
      app.classList.toggle('mobile', mobileMode);
      localStorage.setItem('site-compare-mode', mobileMode ? 'mobile' : 'desktop');
      setUrlParam('mode', mobileMode ? 'mobile' : 'desktop');
      renderSettings();
    });
    function setOverlayAmount(value) {
      overlayAmount = Math.max(0, Math.min(100, Math.round(value)));
      root.style.setProperty('--overlay', (overlayAmount / 100).toFixed(3));
      for (const slider of overlaySliders) slider.value = String(overlayAmount);
      localStorage.setItem('site-compare-overlay-amount', String(overlayAmount));
      setUrlParam('overlayAmount', overlayAmount);
    }
    function renderModes() {
      for (const button of modeButtons) {
        const active = button.dataset.mode === viewMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      const diffActive = viewMode === 'overlay' && overlayBlend === 'difference';
      for (const button of blendButtons) {
        button.classList.toggle('active', diffActive);
        button.setAttribute('aria-pressed', diffActive ? 'true' : 'false');
      }
    }
    // Split / Solo / Overlay are the mutually-exclusive layouts; Diff is the
    // overlay's blend (the slider's far end), toggled within Overlay.
    function setMode(mode) {
      if (!['split', 'solo', 'overlay'].includes(mode)) mode = 'split';
      viewMode = mode;
      app.classList.toggle('solo', mode === 'solo');
      app.classList.toggle('overlay', mode === 'overlay');
      app.classList.toggle('diff', mode === 'overlay' && overlayBlend === 'difference');
      app.dataset.focus = focusSide;
      localStorage.setItem('site-compare-view', mode);
      setUrlParam('view', mode === 'split' ? null : mode);
      renderModes();
      applyOrder();
      // Overlay forces scroll-lock, so refresh scrollbar hiding + re-align.
      for (const side of ['dev', 'live']) {
        const doc = frame(side).contentDocument;
        if (doc) applyScrollPresentation(doc);
      }
      if (stacked()) alignSide(order[1], order[0]);
    }
    function setOverlayBlend(blend) {
      overlayBlend = blend === 'difference' ? 'difference' : 'opacity';
      app.classList.toggle('diff', viewMode === 'overlay' && overlayBlend === 'difference');
      localStorage.setItem('site-compare-overlay-blend', overlayBlend);
      setUrlParam('overlayBlend', overlayBlend === 'difference' ? 'difference' : null);
      renderModes();
    }
    for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
    for (const slider of overlaySliders) slider.addEventListener('input', () => {
      if (viewMode !== 'overlay') setMode('overlay');
      if (overlayBlend === 'difference') setOverlayBlend('opacity');
      setOverlayAmount(Number(slider.value));
    });
    for (const button of blendButtons) button.addEventListener('click', () => {
      if (viewMode !== 'overlay') setMode('overlay');
      setOverlayBlend(overlayBlend === 'difference' ? 'opacity' : 'difference');
    });

    function setCompact(value) {
      compactMode = value;
      app.classList.toggle('compact', compactMode);
      saveBool('compact', 'site-compare-compact', compactMode);
    }
    for (const button of document.querySelectorAll('[data-action="compact"]')) {
      button.addEventListener('click', () => setCompact(!compactMode));
    }

    function applyNotes(notes) {
      const list = Array.isArray(notes) ? notes : [];
      const signature = JSON.stringify(list);
      if (signature === notesSignature) return;
      notesSignature = signature;
      reviewNotes = list;
      renderNotes();
    }

    async function notesPull() {
      try {
        const res = await fetch('/notes', { cache: 'no-store' });
        const data = await res.json();
        applyNotes(data.notes);
      } catch {}
    }

    async function notesPost(op) {
      try {
        const res = await fetch('/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(op),
        });
        const data = await res.json();
        applyNotes(data.notes);
      } catch {}
    }

    function authorClass(name) {
      const who = String(name || '').toLowerCase();
      return who === 'joe' ? 'joe' : who === 'claude' ? 'claude' : 'other';
    }

    function renderNotes() {
      noteList.replaceChildren();
      for (const note of reviewNotes) {
        const item = document.createElement('li');
        if (note.done) item.classList.add('done');

        const metaRow = document.createElement('div');
        metaRow.className = 'note-meta';
        const who = document.createElement('span');
        who.className = 'note-author ' + authorClass(note.author);
        who.textContent = note.author || 'note';
        metaRow.append(who);
        const where = [note.side ? note.side.toUpperCase() : '', note.route && note.route !== '/' ? note.route : '']
          .filter(Boolean).join(' · ');
        if (where) {
          const tag = document.createElement('span');
          tag.className = 'note-where';
          tag.textContent = where;
          metaRow.append(tag);
        }
        item.append(metaRow);

        const text = document.createElement('div');
        text.className = 'note-text';
        text.textContent = note.text;
        if (note.route) {
          text.classList.add('note-go');
          text.title = 'Go to ' + note.route + (note.side ? ' · ' + note.side.toUpperCase() : '');
          text.addEventListener('click', () => {
            if (note.side) { focusSide = note.side; app.dataset.focus = focusSide; renderModes(); }
            go(note.route);
          });
        }
        item.append(text);

        const toggle = document.createElement('button');
        toggle.className = 'note-toggle';
        toggle.textContent = note.done ? '↺' : '✓';
        toggle.title = note.done ? 'Reopen note' : 'Mark done';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.addEventListener('click', () => notesPost({ op: 'toggle', id: note.id }));
        item.append(toggle);

        const copy = document.createElement('button');
        copy.className = 'note-copy';
        copy.title = 'Copy a link to this note';
        copy.setAttribute('aria-label', 'Copy link to this note');
        copy.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5v5A1.5 1.5 0 0 1 14.5 12H12" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="8" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
        copy.addEventListener('click', async () => {
          const url = new URL(location.href);
          url.searchParams.set('path', note.route || '/');
          await navigator.clipboard.writeText(url.href);
          showToast('Note link copied');
        });
        item.append(copy);

        const remove = document.createElement('button');
        remove.className = 'remove-note';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove note');
        remove.addEventListener('click', () => notesPost({ op: 'remove', id: note.id }));
        item.append(remove);

        noteList.append(item);
      }
      const open = reviewNotes.filter((note) => !note.done).length;
      for (const count of document.querySelectorAll('[data-action="notes"] .count')) {
        count.textContent = String(open);
        count.style.display = open ? '' : 'none';
      }
    }

    const dockButton = document.querySelector('[data-action="notes-dock"]');
    function applyDock() {
      // Dock pushes the panes aside; float overlays them.
      app.classList.toggle('drawer-dock', notesOpen && dockMode);
      dockButton.classList.toggle('active', dockMode);
      dockButton.setAttribute('aria-pressed', dockMode ? 'true' : 'false');
    }
    function setNotesOpen(value) {
      notesOpen = value;
      notesDrawer.classList.toggle('open', notesOpen);
      setUrlParam('notes', notesOpen ? '1' : '0');
      applyDock();
      if (notesOpen) noteInput.focus();
    }
    dockButton.addEventListener('click', () => {
      dockMode = !dockMode;
      saveBool('dock', 'site-compare-dock', dockMode);
      applyDock();
    });
    for (const button of document.querySelectorAll('[data-action="notes"]')) {
      button.addEventListener('click', () => setNotesOpen(!notesOpen));
    }
    document.querySelector('[data-action="notes-close"]').addEventListener('click', () => setNotesOpen(false));
    addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      let handled = false;
      for (const details of document.querySelectorAll('details[open]')) {
        details.removeAttribute('open');
        handled = true;
      }
      if (notesOpen) {
        setNotesOpen(false);
        handled = true;
      }
      if (handled && (event.target === noteInput || event.target === routeInput)) event.target.blur();
    });
    // Auto-grow the compose box to its content (scroll past a cap), with a
    // floor the user can raise by dragging the top grip.
    const NOTE_MIN = 76;
    let noteFloor = NOTE_MIN;
    function autosizeNote() {
      const hardMax = Math.round(innerHeight * 0.6);
      noteInput.style.height = 'auto';
      const needed = noteInput.scrollHeight;
      const height = Math.min(hardMax, Math.max(NOTE_MIN, noteFloor, needed));
      noteInput.style.height = height + 'px';
      noteInput.style.overflowY = needed > height ? 'auto' : 'hidden';
    }
    noteInput.addEventListener('input', autosizeNote);
    const noteGrip = document.querySelector('.note-grip');
    noteGrip.addEventListener('pointerdown', (event) => {
      noteGrip.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startHeight = noteInput.offsetHeight;
      const onMove = (move) => {
        noteFloor = Math.max(NOTE_MIN, Math.min(Math.round(innerHeight * 0.6), startHeight + (startY - move.clientY)));
        autosizeNote();
      };
      const onUp = (up) => {
        noteGrip.releasePointerCapture(up.pointerId);
        noteGrip.removeEventListener('pointermove', onMove);
        noteGrip.removeEventListener('pointerup', onUp);
      };
      noteGrip.addEventListener('pointermove', onMove);
      noteGrip.addEventListener('pointerup', onUp);
    });
    document.querySelector('[data-action="note-add"]').addEventListener('click', () => {
      const text = noteInput.value.trim();
      if (!text) return;
      noteInput.value = '';
      autosizeNote();
      const side = viewMode === 'solo' ? focusSide : null;
      notesPost({ op: 'add', text, author: config.author || 'joe', route: routeInput.value, side });
    });
    noteInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        document.querySelector('[data-action="note-add"]').click();
      }
    });
    document.querySelector('[data-action="note-export"]').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = '/notes.md';
      link.download = 'site-compare-notes.md';
      link.click();
      showToast('Exported notes .md');
    });
    const vaultButton = document.querySelector('[data-action="note-vault"]');
    if (config.vault) vaultButton.hidden = false;
    vaultButton.addEventListener('click', async () => {
      try {
        const res = await fetch('/notes/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const data = await res.json();
        showToast(data.ok ? 'Saved to vault' : (data.error || 'Vault save failed'));
      } catch {
        showToast('Vault save failed');
      }
    });

    divider.addEventListener('pointerdown', (event) => {
      divider.setPointerCapture(event.pointerId);
      app.classList.add('dragging');
      divider.dataset.pointerDrag = '1';
    });
    divider.addEventListener('pointermove', (event) => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      setSplit(event.clientX / innerWidth * 100);
    });
    divider.addEventListener('pointerup', (event) => {
      divider.releasePointerCapture(event.pointerId);
      app.classList.remove('dragging');
      divider.blur();
      delete divider.dataset.pointerDrag;
    });
    divider.addEventListener('keydown', (event) => {
      const current = parseFloat(getComputedStyle(root).getPropertyValue('--split'));
      if (event.key === 'ArrowLeft') setSplit(current - (event.shiftKey ? 10 : 2));
      if (event.key === 'ArrowRight') setSplit(current + (event.shiftKey ? 10 : 2));
    });

    document.querySelector('[data-action="go"]').addEventListener('click', () => go());
    for (const button of document.querySelectorAll('[data-action="reload"]')) {
      button.addEventListener('click', () => {
        for (const side of ['dev', 'live']) frame(side).contentWindow.location.reload();
      });
    }
    document.querySelector('[data-action="swap"]').addEventListener('click', () => {
      if (viewMode === 'solo') {
        const nextSide = focusSide === 'dev' ? 'live' : 'dev';
        if (syncScroll) alignSide(focusSide, nextSide);
        focusSide = nextSide;
        app.dataset.focus = focusSide;
        setUrlParam('focus', focusSide);
        renderSettings();
      } else {
        order.reverse();
        applyOrder();
        updateDocTitle();
        setUrlParam('swap', order[0] === 'live' ? '1' : '0');
      }
    });
    // Opening one Google preview opens both, anchored under their buttons.
    for (const summary of document.querySelectorAll('.label details > summary')) {
      summary.addEventListener('click', (event) => {
        event.preventDefault();
        setGoogleOpen(!googleOpen());
      });
    }
    document.addEventListener('click', (event) => {
      for (const details of document.querySelectorAll('details.settings[open], details.help[open]')) {
        if (!details.contains(event.target)) details.removeAttribute('open');
      }
      if (googleOpen() && !event.target.closest('.label')) setGoogleOpen(false);
      if (notesOpen && !dockMode && !event.target.closest('.review-drawer') && !event.target.closest('[data-action="notes"]')) {
        setNotesOpen(false);
      }
    });
    document.addEventListener('pointerup', (event) => {
      if (event.target.closest('input, textarea')) return;
      const control = event.target.closest('button, summary');
      if (control && control !== document.activeElement) return;
      control?.blur();
      getSelection()?.removeAllRanges();
    });
    addEventListener('resize', () => {
      for (const details of document.querySelectorAll('.label details[open]')) positionSeoCard(details);
    });
    routeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go();
    });
    addEventListener('keydown', (event) => {
      if (event.target === routeInput || event.target === noteInput) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'r') document.querySelector('[data-action="reload"]').click();
      if (event.key === 's') document.querySelector('[data-action="swap"]').click();
      if (event.key === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
      if (event.key === 'd') {
        if (viewMode === 'overlay' && overlayBlend === 'difference') setMode('split');
        else { setMode('overlay'); setOverlayBlend('difference'); }
      }
      if (event.key === '0') setSplit(50);
      if (event.key === '/') { event.preventDefault(); routeInput.focus(); routeInput.select(); }
    });

    const initialSplit = Number(params.get('split') || localStorage.getItem('site-compare-split')) || 50;
    scrollButton.classList.toggle('active', syncScroll);
    renderScrollMode();
    app.classList.toggle('mobile', mobileMode);
    app.classList.toggle('compact', compactMode);
    app.dataset.focus = focusSide;
    setOverlayAmount(overlayAmount);
    renderSettings();
    notesDrawer.classList.toggle('open', notesOpen);
    applyDock();
    renderNotes();
    autosizeNote();
    setSplit(initialSplit);
    setMode(viewMode);
    go(params.get('path') || '/');
    notesPull();
    setInterval(notesPull, 4000);
  </script>
</body>
</html>`;
}

const handler = async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
  if (requestUrl.pathname === '/health') {
    send(res, 200, JSON.stringify({
      dev: devBase.href.replace(/\/$/, ''),
      live: liveBase.href.replace(/\/$/, ''),
      version: viewerVersion,
    }), 'application/json; charset=utf-8');
  } else if (requestUrl.pathname === '/notes') {
    if (req.method === 'GET') {
      send(res, 200, JSON.stringify({ notes: loadNotes() }), 'application/json; charset=utf-8');
    } else if (req.method === 'POST') {
      // Require a JSON content-type so cross-origin writes need a preflight the
      // server (no CORS headers) will fail — closes the text/plain CSRF path.
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        send(res, 415, 'notes require Content-Type: application/json');
      } else {
        let op = {};
        try {
          op = JSON.parse((await readBody(req)) || '{}');
        } catch {}
        send(res, 200, JSON.stringify({ notes: applyNoteOp(op) }), 'application/json; charset=utf-8');
      }
    } else {
      send(res, 405, 'method not allowed');
    }
  } else if (requestUrl.pathname === '/notes.md') {
    send(res, 200, notesMarkdown(loadNotes()), 'text/markdown; charset=utf-8');
  } else if (requestUrl.pathname === '/notes/save') {
    if (req.method !== 'POST') {
      send(res, 405, 'method not allowed');
    } else if (!vaultDir) {
      send(res, 400, JSON.stringify({ ok: false, error: 'no vault configured' }), 'application/json; charset=utf-8');
    } else {
      try {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        const file = `${vaultDir}/sitedrift-review-${stamp}.md`;
        fs.writeFileSync(file, notesMarkdown(loadNotes()));
        send(res, 200, JSON.stringify({ ok: true, path: file }), 'application/json; charset=utf-8');
      } catch (error) {
        send(res, 500, JSON.stringify({ ok: false, error: error.message }), 'application/json; charset=utf-8');
      }
    }
  } else if (requestUrl.pathname === '/icon.svg') {
    if (iconSvg) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(iconSvg);
    } else {
      send(res, 404, 'no icon');
    }
  } else if (requestUrl.pathname.startsWith('/__dev')) {
    await proxy(req, res, 'dev', requestUrl);
  } else if (requestUrl.pathname.startsWith('/__live')) {
    await proxy(req, res, 'live', requestUrl);
  } else {
    const referer = req.headers.referer || '';
    if (referer.includes('/__dev/')) {
      requestUrl.pathname = `/__dev${requestUrl.pathname}`;
      await proxy(req, res, 'dev', requestUrl);
    } else if (referer.includes('/__live/')) {
      requestUrl.pathname = `/__live${requestUrl.pathname}`;
      await proxy(req, res, 'live', requestUrl);
    } else {
      send(res, 200, viewerHtml(), 'text/html; charset=utf-8');
    }
  }
};

const server = certFile && keyFile
  ? https.createServer({
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
    }, handler)
  : http.createServer(handler);

server.listen(port, host, () => {
  const scheme = certFile && keyFile ? 'https' : 'http';
  const startUrl = `${scheme}://${host}:${port}/`
    + (initialPath ? `?path=${encodeURIComponent(initialPath)}` : '');
  console.log(`sitedrift: ${startUrl}`);
  console.log(`  DEV  ${devBase.href}`);
  console.log(`  LIVE ${liveBase.href}`);
  if (opts.open) openBrowser(startUrl);
});
