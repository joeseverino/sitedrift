import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';

import { HttpError, readBody, send } from './http.ts';
import { createNotes, notesRevision } from './notes.ts';
import { BRIDGE_PATH, createProxy } from './proxy.ts';
import type { Session } from './session.ts';
import type { TlsMaterial } from './tls.ts';
import { assets, renderViewer, VIEWER_VERSION } from './viewer.ts';
import type { Side } from './wire.ts';

export interface ServerSettings {
  host: string;
  hostname?: string;
  port: number;
  devBase: URL;
  liveBase: URL;
  notesFile: string;
  author: string;
  vaultDir: string;
  brand: string;
}

export type ControlSession = Pick<Session, 'version' | 'url' | 'frameUrls' | 'token' | 'dev' | 'live' | 'notesFile' | 'startedAt'>;

/** The control server serves the viewer and API; a frame server serves one side's proxied pages from its own origin. */
export type ServerRole = { control: true } | { control: false; side: Side };

const CAPABILITIES = ['notes:list', 'notes:watch', 'notes:add', 'notes:resolve', 'notes:reopen', 'notes:remove', 'notes:clear'];

function sendAsset(res: ServerResponse, body: string, type: string): void {
  if (!body) return send(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || '';
}

function authorized(req: IncomingMessage, session: ControlSession): boolean {
  if (header(req, 'authorization') !== `Bearer ${session.token}`) return false;
  const referer = header(req, 'referer');
  if (!referer) return true;
  const url = URL.parse(referer);
  return url !== null && proxySide(url.pathname) === null;
}

/** Which side's proxy namespace a path belongs to: `/__dev` or `/__live`, as a whole path segment. */
function proxySide(pathname: string): Side | null {
  for (const side of ['dev', 'live'] as const) {
    const prefix = `/__${side}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return side;
  }
  return null;
}

export function createServer(
  config: ServerSettings,
  tls: TlsMaterial | null,
  session: ControlSession,
  role: ServerRole = { control: true },
): Server {
  const { devBase, liveBase, vaultDir } = config;
  const notes = createNotes(config);
  const { proxy } = createProxy(config);

  // A resource requested by a proxied page (no /__side prefix) is routed by its referer.
  async function proxyByReferer(req: IncomingMessage, res: ServerResponse, requestUrl: URL, only?: Side): Promise<boolean> {
    const referer = header(req, 'referer');
    for (const side of only ? [only] : (['dev', 'live'] as const)) {
      if (referer.includes(`/__${side}/`)) {
        requestUrl.pathname = `/__${side}${requestUrl.pathname}`;
        await proxy(req, res, side, requestUrl);
        return true;
      }
    }
    return false;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '');
      if (hostname !== config.host && hostname !== config.hostname) {
        send(res, 421, 'misdirected request');
        return;
      }
    } catch {
      send(res, 400, 'invalid host');
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url || '/', `http://${config.host}:${config.port}`);
    } catch {
      send(res, 400, 'invalid request target');
      return;
    }
    const { pathname } = requestUrl;

    if (pathname === BRIDGE_PATH) {
      sendAsset(res, assets.bridge, 'text/javascript; charset=utf-8');
      return;
    }

    if (!role.control) {
      if (proxySide(pathname) === role.side) {
        await proxy(req, res, role.side, requestUrl);
      } else if (!(await proxyByReferer(req, res, requestUrl, role.side))) {
        send(res, 404, 'not found');
      }
      return;
    }

    const side = proxySide(pathname);
    if (side) {
      await proxy(req, res, side, requestUrl);
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
          capabilities: CAPABILITIES,
          notes: notes.load(),
        });
      }
    } else if (pathname === '/notes' || pathname === '/api/v1/notes') {
      if (!authorized(req, session)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET') {
        const list = notes.load();
        json(res, 200, { notes: list, revision: notesRevision(list) });
      } else if (req.method === 'POST') {
        // Require a JSON content-type so cross-origin writes need a preflight the
        // server (no CORS headers) will fail: closes the text/plain CSRF path.
        if (!header(req, 'content-type').includes('application/json')) {
          json(res, 415, { error: 'notes require Content-Type: application/json' });
        } else {
          try {
            const op: unknown = JSON.parse((await readBody(req)) || '{}');
            const list = notes.applyOp(op);
            json(res, 200, { notes: list, revision: notesRevision(list) });
          } catch (error) {
            if (error instanceof HttpError) json(res, error.statusCode, { error: error.message });
            else if (error instanceof SyntaxError) json(res, 400, { error: 'invalid JSON' });
            else {
              console.error(error);
              json(res, 500, { error: 'internal error' });
            }
          }
        }
      } else {
        send(res, 405, 'method not allowed');
      }
    } else if (pathname === '/notes.md') {
      send(res, 200, notes.markdown(notes.load()), 'text/markdown; charset=utf-8');
    } else if (pathname === '/notes/save' || pathname === '/api/v1/notes/save') {
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
          console.error(error);
          json(res, 500, { ok: false, error: 'could not write the review file' });
        }
      }
    } else if (pathname === '/icon.svg') {
      sendAsset(res, assets.icon, 'image/svg+xml; charset=utf-8');
    } else if (pathname === '/viewer.css') {
      sendAsset(res, assets.css, 'text/css; charset=utf-8');
    } else if (pathname === '/viewer.js') {
      sendAsset(res, assets.js, 'text/javascript; charset=utf-8');
    } else if (!(await proxyByReferer(req, res, requestUrl))) {
      send(res, 200, renderViewer(config, session), 'text/html; charset=utf-8');
    }
  }

  // Backstop: a request that throws must answer, not take the whole server down.
  const listener: RequestListener = (req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else send(res, 500, 'sitedrift: internal error');
    });
  };

  return tls ? https.createServer(tls, listener) : http.createServer(listener);
}
