import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createServer } from '../src/server.ts';
import { httpRequest, listen } from './helpers.ts';

test('proxy preserves mutation bodies and HEAD semantics', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
  const session = {
    token: 'secret',
    frameUrls: { dev: '', live: '' },
    version: 1,
    url: '',
    dev: '',
    live: '',
    notesFile: config.notesFile,
    startedAt: '',
  };
  const proxy = createServer(config, null, session, { control: false, side: 'dev' });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const payload = JSON.stringify({ saved: true });
  const jsonHeaders = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
  const posted = await httpRequest(proxyPort, '/__dev/api/items?draft=1', { method: 'POST', headers: jsonHeaders, body: payload });
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body), { method: 'POST', body: payload });

  const head = await httpRequest(proxyPort, '/__dev/api/items', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});
