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

test('proxy decodes upstream text with the charset the response declares', async (t) => {
  const latin1 = Buffer.from('<html><head></head><body><a href="/menu">caf\xe9 cr\xe8me</a></body></html>', 'latin1');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/latin1') res.writeHead(200, { 'content-type': 'text/html; charset=ISO-8859-1' });
    else if (req.url === '/unknown') res.writeHead(200, { 'content-type': 'text/html; charset=not-a-charset' });
    else res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/utf8' ? Buffer.from('<html><head></head><body>café</body></html>') : latin1);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const base = new URL(`http://127.0.0.1:${upstreamPort}`);
  const proxy = createServer({
    host: '127.0.0.1',
    hostname: '127.0.0.1',
    port: 4178,
    devBase: base,
    liveBase: base,
    notesFile: `/tmp/sitedrift-charset-${process.pid}.json`,
    author: 'test',
    vaultDir: '',
    brand: '',
  }, null, {
    token: 'secret',
    frameUrls: { dev: '', live: '' },
    version: 1,
    url: '',
    dev: '',
    live: '',
    notesFile: '',
    startedAt: '',
  }, { control: false, side: 'dev' });
  const port = await listen(proxy);
  t.after(() => proxy.close());

  const declared = await httpRequest(port, '/__dev/latin1');
  assert.match(declared.body, /café crème/);
  assert.match(String(declared.headers['content-type']), /charset=utf-8/i);

  const unknown = await httpRequest(port, '/__dev/unknown');
  assert.match(unknown.body, /<body>/);
  assert.doesNotMatch(unknown.body, /café/);

  const plain = await httpRequest(port, '/__dev/utf8');
  assert.match(plain.body, /café/);
  assert.equal(plain.headers['content-type'], 'text/html');
});
