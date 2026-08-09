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
