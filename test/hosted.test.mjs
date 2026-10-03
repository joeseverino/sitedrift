import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installCloudflarePreview } from '../src/cloudflare.mjs';
import cloudflareDefault, { createPreviewHandler, onRequest, sourceCandidates } from '../src/cloudflare-runtime.mjs';

const LIVE = 'https://example.com';

/** In-memory ASSETS binding: path -> [body, content-type, status?]. */
function assetsFrom(files) {
  return {
    async fetch(input) {
      const url = new URL(input.url || input);
      const entry = files[url.pathname];
      if (!entry) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
      const [body, type, status = 200, headers = {}] = entry;
      return new Response(body, { status, headers: { 'content-type': type, ...headers } });
    },
  };
}

function preview(files = {}, config = { live: LIVE }) {
  return assetsFrom({
    '/__sitedrift/config.json': [JSON.stringify(config), 'application/json'],
    ...files,
  });
}

/** Replaces global fetch for one test and records the upstream request. */
function mockLive(t, respond) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: new URL(url), init, headers: new Headers(init.headers) });
    return respond(new URL(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return seen;
}

const request = (url, init) => new Request(`https://feature.example.pages.dev${url}`, init);

test('LIVE receives only the header allowlist and never sets cookies', async (t) => {
  const seen = mockLive(t, () => new Response('<html><head></head><body>live</body></html>', {
    headers: { 'content-type': 'text/html', 'set-cookie': 'session=prod', 'x-frame-options': 'DENY' },
  }));
  const response = await onRequest({
    request: request('/__sitedrift/live/pricing?a=1', {
      headers: {
        accept: 'text/html',
        'accept-language': 'en',
        'user-agent': 'test',
        cookie: 'CF_Authorization=jwt; preview=1',
        authorization: 'Bearer x',
        'cf-access-client-id': 'id',
        'cf-access-client-secret': 'secret',
        'x-forwarded-for': '1.2.3.4',
      },
    }),
    env: { ASSETS: preview() },
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.href, 'https://example.com/pricing?a=1');
  assert.deepEqual([...seen[0].headers.keys()].sort(), ['accept', 'accept-language', 'user-agent']);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('forwardHeaders and securityHeaders are configurable', async (t) => {
  const seen = mockLive(t, () => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  const handler = createPreviewHandler({
    forwardHeaders: ['accept', 'cache-control'],
    securityHeaders: { 'x-frame-options': 'DENY', 'permissions-policy': 'camera=()' },
  });
  const response = await handler.onRequest({
    request: request('/__sitedrift/live/', { headers: { 'cache-control': 'no-cache', 'user-agent': 'x' } }),
    env: { ASSETS: preview() },
  });
  assert.deepEqual([...seen[0].headers.keys()], ['cache-control']);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('permissions-policy'), 'camera=()');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

  const bare = await createPreviewHandler({ securityHeaders: false }).onRequest({
    request: request('/__sitedrift/live/'),
    env: { ASSETS: preview() },
  });
  assert.equal(bare.headers.has('x-frame-options'), false);
});

test('answers 404 on the production host and without a preview config', async (t) => {
  mockLive(t, () => { throw new Error('must not reach production'); });
  for (const host of ['example.com', 'www.example.com']) {
    const response = await onRequest({
      request: new Request(`https://${host}/__sitedrift/live/`),
      env: { ASSETS: preview() },
    });
    assert.equal(response.status, 404, host);
  }
  const custom = await createPreviewHandler({ productionHosts: ['preview-blocked.example'] }).onRequest({
    request: new Request('https://preview-blocked.example/__sitedrift/dev/'),
    env: { ASSETS: preview() },
  });
  assert.equal(custom.status, 404);
  const unconfigured = await onRequest({ request: request('/__sitedrift/dev/'), env: { ASSETS: assetsFrom({}) } });
  assert.equal(unconfigured.status, 404);
  const productionBranch = await onRequest({
    request: request('/__sitedrift/dev/'),
    env: { ASSETS: preview(), CF_PAGES_BRANCH: 'main' },
  });
  assert.equal(productionBranch.status, 404);
});

test('nonce stamps the bridge and restamps only nonced LIVE tags', async (t) => {
  mockLive(t, () => new Response(
    '<html><head><script nonce="prod123" src="/_astro/a.js"></script><style nonce="prod123">a{}</style>'
      + '<script>injected()</script></head><body></body></html>',
    { headers: { 'content-type': 'text/html' } },
  ));
  const response = await onRequest({
    request: request('/__sitedrift/live/'),
    env: { ASSETS: preview({}, { live: LIVE, nonce: '__CSP_NONCE__' }) },
  });
  const body = await response.text();
  assert.match(body, /<script nonce="__CSP_NONCE__" src="\/__sitedrift\/live\/_astro\/a.js">/);
  assert.match(body, /<style nonce="__CSP_NONCE__">/);
  assert.match(body, /<script>injected\(\)<\/script>/);
  assert.match(body, /<script src="\/__sitedrift\/assets\/bridge.js" data-side="live" data-prefix="\/__sitedrift\/live" nonce="__CSP_NONCE__"><\/script><\/head>/);
  assert.doesNotMatch(body, /prod123/);

  const perRequest = await createPreviewHandler({ nonce: () => 'abc123' }).onRequest({
    request: request('/__sitedrift/live/'),
    env: { ASSETS: preview() },
  });
  assert.match(await perRequest.text(), /bridge.js" data-side="live" data-prefix="\/__sitedrift\/live" nonce="abc123"/);
});

test('DEV serves source copies regardless of method and Accept, and never nests the viewer', async () => {
  const viewer = '<!doctype html><script type="application/json" id="sitedrift-config">{}</script>';
  const assets = preview({
    '/__sitedrift_source/index.html.txt': ['<html><head></head><h1>Home</h1></html>', 'text/plain'],
    '/__sitedrift_source/about/index.html.txt': ['<html><head></head><h1>About</h1></html>', 'text/plain'],
    '/__sitedrift_source/docs.html.txt': ['<html><head></head><h1>Docs</h1></html>', 'text/plain'],
    '/missing': [viewer, 'text/html', 200],
    '/gone': ['<h1>Not found</h1>', 'text/html', 404],
  });
  const env = { ASSETS: assets };
  const head = await onRequest({ request: request('/__sitedrift/dev/', { method: 'HEAD' }), env });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);

  const json = await onRequest({ request: request('/__sitedrift/dev/about/', { headers: { accept: 'application/json' } }), env });
  assert.match(await json.text(), /About/);

  const explicit = await onRequest({ request: request('/__sitedrift/dev/about/index.html'), env });
  assert.match(await explicit.text(), /About/);
  const flat = await onRequest({ request: request('/__sitedrift/dev/docs'), env });
  assert.match(await flat.text(), /Docs/);

  const fallback = await onRequest({ request: request('/__sitedrift/dev/missing'), env });
  assert.equal(fallback.status, 404);
  assert.doesNotMatch(await fallback.text(), /sitedrift-config/);

  const notFound = await onRequest({ request: request('/__sitedrift/dev/gone'), env });
  assert.equal(notFound.status, 404);
  assert.match(await notFound.text(), /Not found/);
});

test('source candidates map each route shape once', () => {
  assert.deepEqual(sourceCandidates('/'), ['/__sitedrift_source/index.html.txt']);
  assert.deepEqual(sourceCandidates('/a/'), ['/__sitedrift_source/a/index.html.txt']);
  assert.deepEqual(sourceCandidates('/a/index.html'), ['/__sitedrift_source/a/index.html.txt']);
  assert.deepEqual(sourceCandidates('/a'), ['/__sitedrift_source/a.html.txt', '/__sitedrift_source/a/index.html.txt']);
});

test('hashed assets keep their cache policy; pages are no-store', async () => {
  const env = {
    ASSETS: preview({
      '/_astro/app.abc.js': ['import("/_astro/x.js")', 'text/javascript', 200, { 'cache-control': 'public, max-age=31536000, immutable' }],
      '/__sitedrift_source/index.html.txt': ['<html><head></head></html>', 'text/plain'],
    }),
  };
  const asset = await onRequest({ request: request('/__sitedrift/dev/_astro/app.abc.js'), env });
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await asset.text(), /"\/__sitedrift\/dev\/_astro\/x.js"/);
  const page = await onRequest({ request: request('/__sitedrift/dev/'), env });
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('LIVE redirects stay under the proxy or stop at the origin boundary', async (t) => {
  let location = '/new-home?x=1';
  mockLive(t, () => new Response(null, { status: 301, headers: { location } }));
  const env = { ASSETS: preview() };
  const same = await onRequest({ request: request('/__sitedrift/live/old'), env });
  assert.equal(same.headers.get('location'), '/__sitedrift/live/new-home?x=1');

  location = 'https://login.example.net/sso';
  const off = await onRequest({ request: request('/__sitedrift/live/old'), env });
  assert.equal(off.status, 301);
  assert.equal(off.headers.has('location'), false);
  assert.match(await off.text(), /outside https:\/\/example\.com/);
});

test('Workers entry serves the same routes and passes other paths to assets', async (t) => {
  mockLive(t, () => new Response('live', { headers: { 'content-type': 'text/plain' } }));
  const env = { ASSETS: preview({ '/app.css': ['body{}', 'text/css'] }) };
  const proxied = await cloudflareDefault.fetch(request('/__sitedrift/live/'), env);
  assert.equal(await proxied.text(), 'live');
  const asset = await cloudflareDefault.fetch(request('/app.css'), env);
  assert.equal(await asset.text(), 'body{}');
});

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-hosted-'));
  fs.mkdirSync(path.join(dir, 'blog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Home</title>');
  fs.writeFileSync(path.join(dir, '404.html'), '<!doctype html><title>Not found</title>');
  fs.writeFileSync(path.join(dir, 'blog', '404.html'), '<!doctype html><title>Blog missing</title>');
  return dir;
}

test('install leaves error pages unwrapped and writes the bridge asset', () => {
  const dir = site();
  const result = installCloudflarePreview({ dir, live: LIVE, env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'feature' } });
  assert.equal(result.files, 1);
  assert.match(fs.readFileSync(path.join(dir, '404.html'), 'utf8'), /Not found/);
  assert.match(fs.readFileSync(path.join(dir, 'blog', '404.html'), 'utf8'), /Blog missing/);
  assert.match(fs.readFileSync(path.join(dir, '__sitedrift', 'assets', 'bridge.js'), 'utf8'), /sitedrift-frame/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '__sitedrift', 'config.json'), 'utf8')), {
    live: LIVE,
    productionBranch: 'main',
  });
});

test('install stamps the nonce on every viewer script, style, and stylesheet', () => {
  const dir = site();
  installCloudflarePreview({ dir, live: LIVE, nonce: '__CSP_NONCE__', env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'feature' } });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const tags = html.match(/<(?:script|style)\b[^>]*>|<link rel="stylesheet"[^>]*>/g);
  assert.ok(tags.length >= 3);
  for (const tag of tags) assert.match(tag, /nonce="__CSP_NONCE__"/, tag);
  assert.doesNotMatch(html, /__SITEDRIFT_CONFIG__/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '__sitedrift', 'config.json'), 'utf8')).nonce, '__CSP_NONCE__');
  assert.throws(
    () => installCloudflarePreview({ dir: site(), live: LIVE, nonce: '"><script>', env: { CF_PAGES: '1', CF_PAGES_BRANCH: 'x' } }),
    /nonce may contain only/,
  );
});

test('install recognizes Workers Builds and skips local builds', () => {
  const dir = site();
  assert.deepEqual(installCloudflarePreview({ dir, live: LIVE, env: {} }), {
    installed: false,
    reason: 'not a Cloudflare preview build',
  });
  assert.equal(installCloudflarePreview({ dir, live: LIVE, env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' } }).reason, 'production branch');
  assert.equal(installCloudflarePreview({ dir, live: LIVE, env: { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'feature' } }).installed, true);
});
