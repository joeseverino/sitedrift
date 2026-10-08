import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import { requestSession } from '../src/agent.ts';
import type { Session } from '../src/session.ts';
import { listen } from './helpers.ts';

test('a missing browser opener does not crash the process', () => {
  const browser = new URL('../src/browser.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { openBrowser } from ${JSON.stringify(browser)}; openBrowser('http://127.0.0.1/', 'sitedrift-no-such-opener'); setTimeout(() => {}, 200);`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

function sessionAt(url: string): Session {
  return {
    version: 1,
    pid: process.pid,
    url,
    frameUrls: { dev: url, live: url },
    token: 'secret',
    dev: 'http://127.0.0.1:4321',
    live: 'https://example.test',
    notesFile: '/tmp/notes.json',
    startedAt: new Date().toISOString(),
  };
}

test('a session whose server is gone reports that, not a bare socket error', async () => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(requestSession(sessionAt(`http://127.0.0.1:${port}`), '/api/v1/notes'), /is not responding/);
});

test('an error response without an error field still produces a message', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"detail":"nope"}');
  });
  const port = await listen(server);
  t.after(() => server.close());
  await assert.rejects(requestSession(sessionAt(`http://127.0.0.1:${port}`), '/x'), /detail/);
});
