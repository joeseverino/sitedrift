import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installCloudflarePreview } from '../src/cloudflare.mjs';
import { onRequest } from '../src/cloudflare-runtime.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-cloudflare-'));
  fs.mkdirSync(path.join(dir, 'about'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Home</title><h1>Preview</h1>');
  fs.writeFileSync(path.join(dir, 'about', 'index.html'), '<!doctype html><title>About</title><h1>About</h1>');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{color:black}');
  return dir;
}

test('does not alter a production Pages build', () => {
  const dir = fixture();
  const before = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const result = installCloudflarePreview({
    dir,
    live: 'https://example.com',
    env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'main' },
  });
  assert.deepEqual(result, { installed: false, reason: 'production branch' });
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dir, '__sitedrift')), false);
});

test('wraps preview HTML and preserves the original build', () => {
  const dir = fixture();
  const result = installCloudflarePreview({
    dir,
    live: 'https://example.com',
    brand: 'Example',
    env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'feature-toolbar' },
  });
  assert.equal(result.installed, true);
  assert.equal(result.files, 2);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /"hosted":true/);
  assert.match(fs.readFileSync(path.join(dir, 'about', 'index.html'), 'utf8'), /"initialPath":"\/about\/"/);
  assert.match(fs.readFileSync(path.join(dir, '__sitedrift_source', 'index.html.txt'), 'utf8'), /Preview/);
  assert.equal(fs.readFileSync(path.join(dir, 'app.css'), 'utf8'), 'body{color:black}');
});

test('the edge runtime serves preserved preview HTML through the scoped proxy', async () => {
  const files = new Map([
    ['/__sitedrift/config.json', new Response(JSON.stringify({ live: 'https://example.com' }), {
      headers: { 'content-type': 'application/json' },
    })],
    ['/__sitedrift_source/index.html.txt', new Response(
      '<!doctype html><head></head><body><img src="/image.png"><h1>Preview</h1></body>',
      { headers: { 'content-type': 'text/plain', 'x-frame-options': 'DENY' } },
    )],
  ]);
  const context = {
    request: new Request('https://preview.example/__sitedrift/dev/', {
      headers: { accept: 'text/html' },
    }),
    env: {
      ASSETS: {
        fetch(input) {
          const pathname = new URL(input.url || input).pathname;
          return Promise.resolve(files.get(pathname)?.clone() || new Response('missing', { status: 404 }));
        },
      },
    },
  };
  const response = await onRequest(context);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('x-frame-options'), false);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(body, /src="\/__sitedrift\/dev\/image.png"/);
  assert.match(body, /sitedrift-frame/);
  assert.match(body, /send\('dismiss'\)/);
  assert.match(body, /transferSize/);
});

test('the edge runtime is read-only', async () => {
  const response = await onRequest({
    request: new Request('https://preview.example/__sitedrift/live/api/contact', {
      method: 'POST',
      body: 'message=test',
    }),
    env: { ASSETS: { fetch() { throw new Error('must not fetch'); } } },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
