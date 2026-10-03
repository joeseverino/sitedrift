import assert from 'node:assert/strict';
import test from 'node:test';

import { createProxy } from '../src/proxy.mjs';

test('proxy accepts only credential-free HTTP(S) origins', () => {
  const liveBase = new URL('https://example.test');

  assert.throws(
    () => createProxy({ devBase: new URL('file:///tmp/site'), liveBase }),
    /must be an HTTP\(S\) URL/,
  );
  assert.throws(
    () => createProxy({ devBase: new URL('https://user:secret@example.test'), liveBase }),
    /without credentials/,
  );
});

test('proxy target construction cannot replace the configured origin', async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (target) => {
    requested = target;
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  };

  const { proxy } = createProxy({
    devBase: new URL('https://dev.example.test'),
    liveBase: new URL('https://live.example.test'),
  });
  const response = {
    writeHead() {},
    end() {},
  };

  try {
    await proxy(
      { headers: {}, method: 'GET' },
      response,
      'dev',
      new URL('http://localhost/__dev//attacker.example/path?preview=1'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requested.origin, 'https://dev.example.test');
  assert.equal(requested.pathname, '//attacker.example/path');
  assert.equal(requested.search, '?preview=1');
});

function capture() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    res: {
      writeHead(status, headers = {}) { out.status = status; out.headers = headers; },
      end(body) { out.body = body === undefined ? '' : String(body); },
    },
  };
}

test('local LIVE proxy sends only the header allowlist, GET/HEAD only, and drops cookies', async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (target, init) => {
    seen.push({ target, init, headers: new Headers(init.headers) });
    return new Response('<html><head></head></html>', {
      headers: { 'content-type': 'text/html', 'set-cookie': 'prod=1' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { proxy } = createProxy({
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://live.example.test'),
  });
  const headers = { cookie: 'local=1', authorization: 'Bearer x', accept: 'text/html', 'user-agent': 'ua', host: '127.0.0.1:4180' };

  const get = capture();
  await proxy({ headers, method: 'GET' }, get.res, 'live', new URL('http://localhost/__live/p'));
  assert.deepEqual([...seen[0].headers.keys()].sort(), ['accept', 'user-agent']);
  assert.equal(get.out.headers['set-cookie'], undefined);
  assert.match(get.out.body, /<script src="\/__sitedrift\/assets\/bridge.js\?v=\d+" data-side="live" data-prefix="\/__live"><\/script>/);

  const post = capture();
  await proxy({ headers, method: 'POST' }, post.res, 'live', new URL('http://localhost/__live/api'));
  assert.equal(post.out.status, 405);
  assert.equal(seen.length, 1);

  const dev = capture();
  await proxy({ headers, method: 'GET' }, dev.res, 'dev', new URL('http://localhost/__dev/p'));
  assert.equal(seen[1].headers.get('cookie'), 'local=1');
  assert.equal(seen[1].headers.get('host'), '127.0.0.1:4321');
  assert.deepEqual(dev.out.headers['set-cookie'], ['prod=1']);
});

test('local proxy maps same-origin redirects and stops at the origin boundary', async (t) => {
  const originalFetch = globalThis.fetch;
  let location = '/next';
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const { proxy } = createProxy({
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://live.example.test'),
  });
  const same = capture();
  await proxy({ headers: {}, method: 'GET' }, same.res, 'live', new URL('http://localhost/__live/old'));
  assert.equal(same.out.headers.location, '/__live/next');
  location = 'https://elsewhere.example/';
  const off = capture();
  await proxy({ headers: {}, method: 'GET' }, off.res, 'live', new URL('http://localhost/__live/old'));
  assert.equal(off.out.headers.location, undefined);
  assert.match(off.out.body, /outside https:\/\/live\.example\.test/);
});
