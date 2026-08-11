import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createServer } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, pathname, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy preserves mutation bodies and HEAD semantics', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const config = {
    host: '127.0.0.1',
    hostname: '127.0.0.1',
    port: 4178,
    devBase: new URL(`http://127.0.0.1:${upstreamPort}`),
    liveBase: new URL(`http://127.0.0.1:${upstreamPort}`),
    notesFile: `/tmp/sitedrift-proxy-${process.pid}.json`,
    author: 'test',
    vaultDir: '',
    brand: '',
  };
  const session = { token: 'secret', frameUrls: {}, version: 1 };
  const proxy = createServer(config, null, session, { control: false, side: 'dev' });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const payload = JSON.stringify({ saved: true });
  const posted = await request(proxyPort, '/__dev/api/items?draft=1', { method: 'POST', body: payload });
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body), { method: 'POST', body: payload });

  const head = await request(proxyPort, '/__dev/api/items', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});
