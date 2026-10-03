import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { bridgeTag, checkNonce, injectBridge, restampNonces, rewriteRootPaths } from '../src/frame-content.mjs';
import { renderHostedViewer, renderViewer } from '../src/viewer.mjs';

test('rewrites Vite preload deps in scripts only', () => {
  const chunk = 'const assetsURL=function(e){return"/"+e};__vite__mapDeps([0,1],["_astro/a.js","_astro/b.css"]);import("/_astro/c.js")';
  const script = rewriteRootPaths(chunk, '/__sitedrift/live', { script: true });
  assert.match(script, /"__sitedrift\/live\/_astro\/a.js","__sitedrift\/live\/_astro\/b.css"/);
  assert.match(script, /import\("\/__sitedrift\/live\/_astro\/c.js"\)/);
  assert.doesNotMatch(script, /__sitedrift\/live\/__sitedrift/);
  const local = rewriteRootPaths('["_astro/a.js"]', '/__live', { script: true });
  assert.equal(local, '["__live/_astro/a.js"]');
  const html = rewriteRootPaths('<a href="_astro/a.js">', '/__live');
  assert.equal(html, '<a href="_astro/a.js">');
});

test('restamps existing nonces without adding new ones', () => {
  const html = '<script nonce="a">1</script><script>2</script><style nonce=\'b\'></style><script type="module" nonce=c src="/x.js"></script>';
  assert.equal(
    restampNonces(html, 'N1'),
    '<script nonce="N1">1</script><script>2</script><style nonce="N1"></style><script type="module" nonce="N1" src="/x.js"></script>',
  );
  assert.equal(restampNonces(html, ''), html);
});

test('bridge tags are external, attribute-safe, and injected before </head>', () => {
  const tag = bridgeTag({ src: '/b.js', side: 'dev', prefix: '/__dev', nonce: 'abc' });
  assert.equal(tag, '<script src="/b.js" data-side="dev" data-prefix="/__dev" nonce="abc"></script>');
  assert.equal(injectBridge('<html><HEAD></HEAD>', tag), `<html><HEAD>${tag}</HEAD>`);
  assert.equal(injectBridge('<p>no head', tag), `${tag}<p>no head`);
  for (const bad of ['"><script>', 'a b', "x'"]) assert.throws(() => checkNonce(bad), /nonce may contain only/);
  assert.equal(checkNonce(undefined), '');
});

test('viewer pages carry config as inert JSON and no inline script', () => {
  const session = { token: 'tok</script>', frameUrls: { dev: 'http://127.0.0.1:1', live: 'http://127.0.0.1:2' } };
  const local = renderViewer({
    devBase: new URL('http://127.0.0.1:4321'),
    liveBase: new URL('https://example.com'),
    brand: '$& brand',
    author: 'me',
    vaultDir: '',
  }, session);
  const hosted = renderHostedViewer({ live: 'https://example.com', nonce: 'n0nce' });
  for (const html of [local, hosted]) {
    const config = html.match(/<script[^>]*type="application\/json" id="sitedrift-config">([^<]*)<\/script>/);
    assert.ok(config, 'config block present');
    assert.equal(typeof JSON.parse(config[1]), 'object');
    for (const tag of html.match(/<script\b[^>]*>/gi)) {
      assert.match(tag, /\bsrc=|type="application\/json"/, tag);
    }
  }
  assert.equal(JSON.parse(local.match(/id="sitedrift-config">([^<]*)</)[1]).brand, '$& brand');
  assert.doesNotMatch(local, /tok<\/script>/);
});

test('the bridge asset reads its side from data attributes and has no HTML sinks', () => {
  const bridge = fs.readFileSync(new URL('../assets/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /document\.currentScript/);
  assert.match(bridge, /dataset\.side/);
  const viewer = fs.readFileSync(new URL('../assets/viewer.js', import.meta.url), 'utf8');
  for (const source of [bridge, viewer]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  }
});
