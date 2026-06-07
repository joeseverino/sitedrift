import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseCommand, resolveConfig } from '../src/cli.mjs';

const viewerScript = fs.readFileSync(new URL('../assets/viewer.js', import.meta.url), 'utf8');
const viewerHtml = fs.readFileSync(new URL('../assets/viewer.html', import.meta.url), 'utf8');

test('rejects unknown options and invalid ports', () => {
  const live = ['--live', 'https://example.test'];
  assert.throws(() => resolveConfig(['--wat', ...live]), /Unknown option/);
  assert.throws(() => resolveConfig(['--port', 'nope', ...live]), /Port must be an integer/);
  assert.throws(() => resolveConfig(['--port', '65534', ...live]), /next two ports/);
  assert.throws(() => resolveConfig(['--host', 'compare.homelab', ...live]), /Host must be loopback/);
  assert.throws(() => resolveConfig(['--hostname', 'bad host', ...live]), /Hostname must be a valid/);
});

test('requires certificate and key together', () => {
  assert.throws(() => resolveConfig([
    '--cert', '/tmp/cert.pem',
    '--live', 'https://example.test',
  ]), /provided together/);
});

test('requires an explicit production URL', () => {
  assert.throws(() => resolveConfig([]), /Missing production URL/);
  assert.doesNotThrow(() => resolveConfig(['--help']));
  assert.doesNotThrow(() => resolveConfig([], { requireLive: false }));
});

test('separates the loopback bind address from a local browser hostname', () => {
  const config = resolveConfig([
    '--host', '127.0.0.1',
    '--hostname', 'compare.homelab',
    '--cert', '/tmp/fullchain.pem',
    '--key', '/tmp/compare.homelab.key',
    '--live', 'https://example.test',
  ]);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.hostname, 'compare.homelab');
});

test('loads explicit project configuration with flag precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-config-'));
  const file = path.join(dir, 'sitedrift.config.json');
  fs.writeFileSync(file, JSON.stringify({
    dev: 'http://localhost:3000',
    live: 'https://example.test',
    port: 4100,
    hostname: 'compare.homelab',
    author: 'agent',
  }));
  const config = resolveConfig(['--config', file, '--port', '4200']);
  assert.equal(config.devBase.href, 'http://localhost:3000/');
  assert.equal(config.liveBase.href, 'https://example.test/');
  assert.equal(config.port, 4200);
  assert.equal(config.hostname, 'compare.homelab');
  assert.equal(config.author, 'agent');
});

test('parses agent note commands', () => {
  const parsed = parseCommand(['notes', 'add', 'CTA differs', '--route', '/pricing', '--side', 'live']);
  assert.deepEqual(parsed.command, {
    name: 'notes',
    action: 'add',
    text: 'CTA differs',
    id: undefined,
    route: '/pricing',
    side: 'live',
    author: undefined,
  });
});

test('parses the Cloudflare preview command', () => {
  const parsed = parseCommand([
    'cloudflare',
    '--dir', 'build',
    '--live', 'https://example.test',
    '--production-branch', 'trunk',
  ]);
  assert.deepEqual(parsed.command, {
    name: 'cloudflare',
    dir: 'build',
    live: 'https://example.test',
    brand: '',
    productionBranch: 'trunk',
  });
});

test('viewer uses neutral pane identity and current help copy', () => {
  assert.match(viewerScript, /neutralSiteIcon/);
  assert.doesNotMatch(viewerScript, /const appIcon/);
  assert.match(viewerHtml, /hosted preview against production/);
  assert.doesNotMatch(viewerHtml, /Local dev and production, locked/);
});
