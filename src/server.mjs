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

function json(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function authorized(req, session) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${session.token}`) return false;
  const referer = req.headers.referer || '';
  if (!referer) return true;
  try {
    const pathname = new URL(referer).pathname;
    return !pathname.startsWith('/__dev') && !pathname.startsWith('/__live');
  } catch {
    return false;
  }
}

export function createServer(config, tls, session, { control = true, side: frameSide } = {}) {
  const { devBase, liveBase, vaultDir } = config;
  const notes = createNotes(config);
  const { proxy } = createProxy(config);

  const handler = async (req, res) => {
    try {
      const hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '');
      if (hostname !== config.host) {
        send(res, 421, 'misdirected request');
        return;
      }
    } catch {
      send(res, 400, 'invalid host');
      return;
    }
    const requestUrl = new URL(req.url || '/', `http://${config.host}:${config.port}`);
    const { pathname } = requestUrl;

    const isNotes = pathname === '/notes' || pathname === '/api/v1/notes';
    const isSave = pathname === '/notes/save' || pathname === '/api/v1/notes/save';

    if (!control && frameSide && !pathname.startsWith(`/__${frameSide}`)) {
      const referer = req.headers.referer || '';
      if (referer.includes(`/__${frameSide}/`)) {
        requestUrl.pathname = `/__${frameSide}${pathname}`;
        await proxy(req, res, frameSide, requestUrl);
      } else {
        send(res, 404, 'not found');
      }
      return;
    }

    if (!control && !pathname.startsWith('/__dev') && !pathname.startsWith('/__live')) {
      const referer = req.headers.referer || '';
      if (referer.includes('/__dev/')) {
        requestUrl.pathname = `/__dev${pathname}`;
        await proxy(req, res, 'dev', requestUrl);
      } else if (referer.includes('/__live/')) {
        requestUrl.pathname = `/__live${pathname}`;
        await proxy(req, res, 'live', requestUrl);
      } else {
        send(res, 404, 'not found');
      }
    } else if (pathname === '/health') {
      send(res, 200, JSON.stringify({
        dev: devBase.href.replace(/\/$/, ''),
        live: liveBase.href.replace(/\/$/, ''),
        version: VIEWER_VERSION,
      }), 'application/json; charset=utf-8');
    } else if (pathname === '/api/v1/session') {
      if (!authorized(req, session)) {
        json(res, 401, { error: 'unauthorized' });
      } else {
        json(res, 200, {
          session: {
            version: session.version,
            url: session.url,
            dev: session.dev,
            live: session.live,
            notesFile: session.notesFile,
            startedAt: session.startedAt,
          },
          capabilities: ['notes:list', 'notes:add', 'notes:resolve', 'notes:reopen', 'notes:remove', 'notes:clear'],
          notes: notes.load(),
        });
      }
    } else if (isNotes) {
      if (!authorized(req, session)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, { notes: notes.load() });
      } else if (req.method === 'POST') {
        // Require a JSON content-type so cross-origin writes need a preflight the
        // server (no CORS headers) will fail — closes the text/plain CSRF path.
        if (!(req.headers['content-type'] || '').includes('application/json')) {
          json(res, 415, { error: 'notes require Content-Type: application/json' });
        } else {
          try {
            const op = JSON.parse((await readBody(req)) || '{}');
            json(res, 200, { notes: notes.applyOp(op) });
          } catch (error) {
            json(res, 400, { error: error.message });
          }
        }
      } else {
        send(res, 405, 'method not allowed');
      }
    } else if (pathname === '/notes.md') {
      send(res, 200, notes.markdown(notes.load()), 'text/markdown; charset=utf-8');
    } else if (isSave) {
      if (!authorized(req, session)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        send(res, 405, 'method not allowed');
      } else if (!vaultDir) {
        json(res, 400, { ok: false, error: 'no vault configured' });
      } else {
        try {
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const file = `${vaultDir}/sitedrift-review-${stamp}.md`;
          fs.writeFileSync(file, notes.markdown(notes.load()));
          json(res, 200, { ok: true, path: file });
        } catch (error) {
          json(res, 500, { ok: false, error: error.message });
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
        send(res, 200, renderViewer(config, session), 'text/html; charset=utf-8');
      }
    }
  };

  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}
