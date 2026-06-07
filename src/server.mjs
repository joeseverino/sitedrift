import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

import { send, readBody } from './http.mjs';
import { createNotes } from './notes.mjs';
import { createProxy } from './proxy.mjs';
import { assets, renderViewer, VIEWER_VERSION } from './viewer.mjs';

function sendAsset(res, body, type) {
  if (!body) return send(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
  res.end(body);
}

export function createServer(config) {
  const { devBase, liveBase, certFile, keyFile, vaultDir } = config;
  const notes = createNotes(config);
  const { proxy } = createProxy(config);

  const handler = async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${config.host}:${config.port}`);
    const { pathname } = requestUrl;

    if (pathname === '/health') {
      send(res, 200, JSON.stringify({
        dev: devBase.href.replace(/\/$/, ''),
        live: liveBase.href.replace(/\/$/, ''),
        version: VIEWER_VERSION,
      }), 'application/json; charset=utf-8');
    } else if (pathname === '/notes') {
      if (req.method === 'GET') {
        send(res, 200, JSON.stringify({ notes: notes.load() }), 'application/json; charset=utf-8');
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
          send(res, 200, JSON.stringify({ notes: notes.applyOp(op) }), 'application/json; charset=utf-8');
        }
      } else {
        send(res, 405, 'method not allowed');
      }
    } else if (pathname === '/notes.md') {
      send(res, 200, notes.markdown(notes.load()), 'text/markdown; charset=utf-8');
    } else if (pathname === '/notes/save') {
      if (req.method !== 'POST') {
        send(res, 405, 'method not allowed');
      } else if (!vaultDir) {
        send(res, 400, JSON.stringify({ ok: false, error: 'no vault configured' }), 'application/json; charset=utf-8');
      } else {
        try {
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const file = `${vaultDir}/sitedrift-review-${stamp}.md`;
          fs.writeFileSync(file, notes.markdown(notes.load()));
          send(res, 200, JSON.stringify({ ok: true, path: file }), 'application/json; charset=utf-8');
        } catch (error) {
          send(res, 500, JSON.stringify({ ok: false, error: error.message }), 'application/json; charset=utf-8');
        }
      }
    } else if (pathname === '/icon.svg') {
      sendAsset(res, assets.icon, 'image/svg+xml; charset=utf-8');
    } else if (pathname === '/viewer.css') {
      sendAsset(res, assets.css, 'text/css; charset=utf-8');
    } else if (pathname === '/viewer.js') {
      sendAsset(res, assets.js, 'text/javascript; charset=utf-8');
    } else if (pathname.startsWith('/__dev')) {
      await proxy(req, res, 'dev', requestUrl);
    } else if (pathname.startsWith('/__live')) {
      await proxy(req, res, 'live', requestUrl);
    } else {
      // A resource requested by a proxied page (no /__side prefix) is routed by
      // its referer; everything else is the viewer shell.
      const referer = req.headers.referer || '';
      if (referer.includes('/__dev/')) {
        requestUrl.pathname = `/__dev${pathname}`;
        await proxy(req, res, 'dev', requestUrl);
      } else if (referer.includes('/__live/')) {
        requestUrl.pathname = `/__live${pathname}`;
        await proxy(req, res, 'live', requestUrl);
      } else {
        send(res, 200, renderViewer(config), 'text/html; charset=utf-8');
      }
    }
  };

  return certFile && keyFile
    ? https.createServer({
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
      }, handler)
    : http.createServer(handler);
}
