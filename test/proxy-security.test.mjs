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
