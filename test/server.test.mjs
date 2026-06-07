import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.mjs';

function request(port, pathname, { token, referer, hostname, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(hostname ? { host: `${hostname}:${port}` } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(referer ? { referer } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fixture() {
  const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-server-')), 'notes.json');
  const config = {
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
  const session = {
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

test('control API requires a token and rejects framed callers', async (t) => {
  const { config, session } = fixture();
  const server = createServer(config, null, session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

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
  assert.equal(JSON.parse(added.body).notes[0].text, 'Agent note');
});

test('frame listener does not expose viewer or control API', async (t) => {
  const { config, session } = fixture();
  const server = createServer(config, null, session, { control: false, side: 'dev' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  assert.equal((await request(port, '/')).status, 404);
  assert.equal((await request(port, '/api/v1/session', { token: session.token })).status, 404);
  assert.equal((await request(port, '/__live/')).status, 404);
});

test('accepts only the loopback bind name and configured browser hostname', async (t) => {
  const { config, session } = fixture();
  config.hostname = 'compare.homelab';
  const server = createServer(config, null, session);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  assert.equal((await request(port, '/health')).status, 200);
  assert.equal((await request(port, '/health', { hostname: 'compare.homelab' })).status, 200);
  assert.equal((await request(port, '/health', { hostname: 'attacker.example' })).status, 421);
});
