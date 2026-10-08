import assert from 'node:assert/strict';
import test from 'node:test';

import { createProxy } from '../src/proxy.ts';
import { captureResponse, fakeRequest, mockFetch } from './helpers.ts';

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

test('proxy target construction cannot replace the configured origin', async (t) => {
  const calls = mockFetch(t, () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  const { proxy } = createProxy({
    devBase: new URL('https://dev.example.test'),
    liveBase: new URL('https://live.example.test'),
  });

  await proxy(
    fakeRequest(),
    captureResponse().res,
    'dev',
    new URL('http://localhost/__dev//attacker.example/path?preview=1'),
  );

  const requested = calls[0]?.url;
  assert.equal(requested?.origin, 'https://dev.example.test');
  assert.equal(requested?.pathname, '//attacker.example/path');
  assert.equal(requested?.search, '?preview=1');
});

test('proxy only strips the exact /__dev and /__live prefixes', async (t) => {
  const calls = mockFetch(t, () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  const { proxy } = createProxy({
    devBase: new URL('https://dev.example.test'),
    liveBase: new URL('https://live.example.test'),
  });

  await proxy(fakeRequest(), captureResponse().res, 'dev', new URL('http://localhost/__developer/page'));
  assert.equal(calls[0]?.url.pathname, '/__developer/page');
});

test('local LIVE proxy sends only the header allowlist, GET/HEAD only, and drops cookies', async (t) => {
  const calls = mockFetch(t, () => new Response('<html><head></head></html>', {
    headers: { 'content-type': 'text/html', 'set-cookie': 'prod=1' },
  }));
  const { proxy } = createProxy({
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://live.example.test'),
  });
  const headers = { cookie: 'local=1', authorization: 'Bearer x', accept: 'text/html', 'user-agent': 'ua', host: '127.0.0.1:4180' };

  const get = captureResponse();
  await proxy(fakeRequest(headers, 'GET'), get.res, 'live', new URL('http://localhost/__live/p'));
  assert.deepEqual([...(calls[0]?.headers.keys() ?? [])].sort(), ['accept', 'user-agent']);
  assert.equal(get.out.headers['set-cookie'], undefined);
  assert.match(get.out.body, /<script src="\/__sitedrift\/assets\/bridge.js\?v=\d+" data-side="live" data-prefix="\/__live"><\/script>/);

  const post = captureResponse();
  await proxy(fakeRequest(headers, 'POST'), post.res, 'live', new URL('http://localhost/__live/api'));
  assert.equal(post.out.status, 405);
  assert.equal(calls.length, 1);

  const dev = captureResponse();
  await proxy(fakeRequest(headers, 'GET'), dev.res, 'dev', new URL('http://localhost/__dev/p'));
  assert.equal(calls[1]?.headers.get('cookie'), 'local=1');
  assert.equal(calls[1]?.headers.get('host'), '127.0.0.1:4321');
  assert.deepEqual(dev.out.headers['set-cookie'], ['prod=1']);
});

test('local proxy maps same-origin redirects and stops at the origin boundary', async (t) => {
  let location = '/next';
  mockFetch(t, () => new Response(null, { status: 302, headers: { location } }));
  const { proxy } = createProxy({
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://live.example.test'),
  });
  const same = captureResponse();
  await proxy(fakeRequest(), same.res, 'live', new URL('http://localhost/__live/old'));
  assert.equal(same.out.headers.location, '/__live/next');
  location = 'https://elsewhere.example/';
  const off = captureResponse();
  await proxy(fakeRequest(), off.res, 'live', new URL('http://localhost/__live/old'));
  assert.equal(off.out.headers.location, undefined);
  assert.match(off.out.body, /outside https:\/\/live\.example\.test/);
});
