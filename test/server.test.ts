import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createServer } from '../src/server.ts';
import type { ControlSession, ServerRole, ServerSettings } from '../src/server.ts';
import { httpRequest, listen, noteTexts } from './helpers.ts';
import type { HttpResult } from './helpers.ts';

interface RequestOptions {
  token?: string;
  referer?: string;
  hostname?: string;
  method?: string;
  body?: unknown;
  contentType?: string;
}

function request(port: number, pathname: string, options: RequestOptions = {}): Promise<HttpResult> {
  const { token, referer, hostname, method, body, contentType } = options;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return httpRequest(port, pathname, {
    ...(method === undefined ? {} : { method }),
    ...(payload === undefined ? {} : { body: payload }),
    headers: {
      ...(hostname ? { host: `${hostname}:${port}` } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(referer ? { referer } : {}),
      ...(payload === undefined ? {} : { 'content-type': contentType || 'application/json' }),
    },
  });
}

function fixture(): { config: ServerSettings; session: ControlSession } {
  const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-server-')), 'notes.json');
  const config: ServerSettings = {
    host: '127.0.0.1',
    hostname: '127.0.0.1',
    port: 4178,
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://example.com'),
    notesFile,
    author: 'test',
    vaultDir: '',
    brand: '',
  };
  const session: ControlSession = {
    version: 1,
    url: 'http://127.0.0.1:4178',
    frameUrls: {
      dev: 'http://127.0.0.1:4179',
      live: 'http://127.0.0.1:4180',
    },
    token: 'secret',
    dev: 'http://127.0.0.1:4321',
    live: 'https://example.com',
    notesFile,
    startedAt: new Date().toISOString(),
  };
  return { config, session };
}

async function start(
  t: TestContext,
  { config, session }: { config: ServerSettings; session: ControlSession },
  role?: ServerRole,
): Promise<number> {
  const server = createServer(config, null, session, role);
  const port = await listen(server);
  t.after(() => server.close());
  return port;
}

test('control API requires a token and rejects framed callers', async (t) => {
  const fx = fixture();
  const port = await start(t, fx);
  const { session } = fx;

  assert.equal((await request(port, '/api/v1/session')).status, 401);
  assert.equal((await request(port, '/api/v1/session', {
    token: session.token,
    referer: `${session.frameUrls.live}/__live/`,
  })).status, 401);
  assert.equal((await request(port, '/api/v1/session', { token: session.token })).status, 200);

  const added = await request(port, '/api/v1/notes', {
    token: session.token,
    method: 'POST',
    body: { op: 'add', text: 'Agent note', route: '/' },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(noteTexts(added.body), ['Agent note']);
});

test('frame listener does not expose viewer or control API', async (t) => {
  const fx = fixture();
  const port = await start(t, fx, { control: false, side: 'dev' });

  assert.equal((await request(port, '/')).status, 404);
  assert.equal((await request(port, '/api/v1/session', { token: fx.session.token })).status, 404);
  assert.equal((await request(port, '/__live/')).status, 404);
  const bridge = await request(port, '/__sitedrift/assets/bridge.js');
  assert.equal(bridge.status, 200);
  assert.match(bridge.body, /sitedrift-frame/);
});

test('accepts only the loopback bind name and configured browser hostname', async (t) => {
  const fx = fixture();
  fx.config.hostname = 'compare.homelab';
  const port = await start(t, fx);

  assert.equal((await request(port, '/health')).status, 200);
  assert.equal((await request(port, '/health', { hostname: 'compare.homelab' })).status, 200);
  assert.equal((await request(port, '/health', { hostname: 'attacker.example' })).status, 421);
});

test('rejects oversized note payloads with a bounded response', async (t) => {
  const fx = fixture();
  const port = await start(t, fx);

  const response = await request(port, '/api/v1/notes', {
    token: fx.session.token,
    method: 'POST',
    body: JSON.stringify({ op: 'add', text: 'x'.repeat(1_000_001) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), { error: 'request body too large' });
});

test('a request target that is not a valid URL gets a 400 and does not stop the server', async (t) => {
  const fx = fixture();
  const port = await start(t, fx);

  assert.equal((await request(port, '//')).status, 400);
  assert.equal((await request(port, '/health')).status, 200);
});

test('a note body split across chunks inside a multibyte character stays intact', async (t) => {
  const fx = fixture();
  const port = await start(t, fx);

  const body = Buffer.from(JSON.stringify({ op: 'add', text: 'price €5', route: '/' }));
  const split = body.indexOf(0xe2) + 1;
  const result = await new Promise<HttpResult>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/notes',
      method: 'POST',
      headers: { authorization: `Bearer ${fx.session.token}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 25);
  });

  assert.equal(result.status, 200);
  assert.deepEqual(noteTexts(result.body), ['price €5']);
});

test('only whole /__dev and /__live path segments are proxied', async (t) => {
  const fx = fixture();
  const port = await start(t, fx);

  const lookalike = await request(port, '/__developer/page');
  assert.equal(lookalike.status, 200);
  assert.match(lookalike.headers['content-type'] ?? '', /text\/html/);
  assert.match(lookalike.body, /id="sitedrift-config"/);
});
