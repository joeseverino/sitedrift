import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FUNCTION_SOURCE, installCloudflarePreview, scaffoldCloudflarePreview } from '../src/cloudflare.ts';
import { onRequest } from '../src/cloudflare-runtime.ts';
import { assetsFrom } from './helpers.ts';
import type { AssetEntry } from './helpers.ts';

function fixture(): string {
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
  const files: Record<string, AssetEntry> = {
    '/__sitedrift/config.json': [JSON.stringify({ live: 'https://example.com' }), 'application/json'],
    '/__sitedrift_source/index.html.txt': [
      '<!doctype html><head></head><body><img src="/image.png"><h1>Preview</h1></body>',
      'text/plain',
      200,
      { 'x-frame-options': 'DENY' },
    ],
  };
  const context = {
    request: new Request('https://preview.example/__sitedrift/dev/', {
      headers: { accept: 'text/html' },
    }),
    env: { ASSETS: assetsFrom(files) },
  };
  const response = await onRequest(context);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(body, /src="\/__sitedrift\/dev\/image.png"/);
  assert.match(body, /<script src="\/__sitedrift\/assets\/bridge.js" data-side="dev" data-prefix="\/__sitedrift\/dev"><\/script><\/head>/);
  assert.doesNotMatch(body, /<script>/i);
});

test('wrapping the same output again keeps the original pages as the source copies', () => {
  const dir = fixture();
  const options = {
    dir,
    live: 'https://example.com',
    env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'feature-toolbar' },
  };
  const first = installCloudflarePreview(options);
  const wrapped = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const second = installCloudflarePreview(options);

  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), wrapped);
  assert.match(fs.readFileSync(path.join(dir, '__sitedrift_source', 'index.html.txt'), 'utf8'), /<h1>Preview<\/h1>/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '__sitedrift_source', 'index.html.txt'), 'utf8'), /sitedrift-config/);
});

test('scaffolds the scoped Function file and is idempotent', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-init-'));
  const first = scaffoldCloudflarePreview({ cwd, live: 'https://example.com' });
  assert.equal(first.created, true);
  assert.equal(first.functionFile, path.join('functions', '__sitedrift', '[[path]].ts'));
  assert.equal(
    fs.readFileSync(path.join(cwd, first.functionFile), 'utf8'),
    FUNCTION_SOURCE,
  );
  assert.match(first.buildLine, /--live https:\/\/example\.com/);

  const second = scaffoldCloudflarePreview({ cwd, live: 'https://example.com' });
  assert.equal(second.created, false);
});

test('init writes a .js Function and detects the output dir', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-init-'));
  fs.mkdirSync(path.join(cwd, '_site'));
  const result = scaffoldCloudflarePreview({ cwd, js: true });
  assert.equal(result.functionFile, path.join('functions', '__sitedrift', '[[path]].js'));
  assert.equal(result.outDir, '_site');
  assert.match(result.buildLine, /--dir _site/);
});

test('the edge runtime is read-only', async () => {
  const response = await onRequest({
    request: new Request('https://preview.example/__sitedrift/live/api/contact', {
      method: 'POST',
      body: 'message=test',
    }),
    env: { ASSETS: assetsFrom({}) },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
