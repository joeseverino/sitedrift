import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../src/session.mjs';

test('uses the browser hostname for control and isolated frame URLs', () => {
  const session = createSession({
    host: '127.0.0.1',
    hostname: 'compare.homelab',
    port: 4178,
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://example.com'),
    notesFile: '/tmp/notes.json',
  }, 'https');

  assert.equal(session.url, 'https://compare.homelab:4178');
  assert.deepEqual(session.frameUrls, {
    dev: 'https://compare.homelab:4179',
    live: 'https://compare.homelab:4180',
  });
});
