import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs, parseCommand, resolveCloudflareCommand, resolveConfig } from '../src/cli.ts';
import type { CloudflareCommand, Command } from '../src/cli.ts';
import { assets } from '../src/viewer.ts';

function commandOf(argv: string[]): Command {
  const parsed = parseCommand(argv);
  assert.ok(parsed, `${argv.join(' ')} is a command`);
  return parsed.command;
}

function cloudflareOf(argv: string[]): CloudflareCommand {
  const command = commandOf(argv);
  assert.equal(command.name, 'cloudflare');
  assert.ok(command.name === 'cloudflare');
  return command;
}

const viewerHtml = fs.readFileSync(new URL('../assets/viewer.html', import.meta.url), 'utf8');

test('rejects unknown options and invalid ports', () => {
  const live = ['--live', 'https://example.test'];
  assert.throws(() => resolveConfig(['--wat', ...live]), /Unknown option/);
  assert.throws(() => resolveConfig(['--port', 'nope', ...live]), /Port must be an integer/);
  assert.throws(() => resolveConfig(['--port', '65534', ...live]), /next two ports/);
  assert.throws(() => resolveConfig(['--host', 'compare.homelab', ...live]), /Host must be loopback/);
  assert.throws(() => resolveConfig(['--hostname', 'bad host', ...live]), /Hostname must be a valid/);
  assert.throws(() => resolveConfig(['--live', 'file:///tmp/site']), /must be HTTP\(S\)/);
  assert.throws(() => resolveConfig(['--live', 'https://user:secret@example.test']), /without credentials/);
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
  assert.equal(config.liveBase?.href, 'https://example.test/');
  assert.equal(config.port, 4200);
  assert.equal(config.hostname, 'compare.homelab');
  assert.equal(config.author, 'agent');
});

test('parses agent note commands', () => {
  assert.deepEqual(commandOf(['notes', 'add', 'CTA differs', '--route', '/pricing', '--side', 'live']), {
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
  assert.deepEqual(cloudflareOf([
    'cloudflare',
    '--dir', 'build',
    '--live', 'https://example.test',
    '--production-branch', 'trunk',
  ]), {
    name: 'cloudflare',
    action: 'wrap',
    dir: 'build',
    live: 'https://example.test',
    brand: '',
    productionBranch: 'trunk',
    nonce: '',
    js: false,
    config: undefined,
  });
});

test('parses the Cloudflare init command without requiring --live', () => {
  const command = cloudflareOf(['cloudflare', 'init', '--js']);
  assert.equal(command.action, 'init');
  assert.equal(command.js, true);
  assert.equal(command.live, '');
});

test('viewer uses neutral pane identity and current help copy', () => {
  assert.match(assets.js, /neutralSiteIcon/);
  assert.doesNotMatch(assets.js, /const appIcon/);
  assert.match(viewerHtml, /hosted preview against production/);
  assert.doesNotMatch(viewerHtml, /Local dev and production, locked/);
});

test('reads project config from package.json and fills the Cloudflare command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-pkg-'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'site',
    sitedrift: { live: 'https://example.test', dir: 'out', nonce: '__CSP_NONCE__', productionBranch: 'prod' },
  }));
  const resolved = resolveCloudflareCommand(cloudflareOf(['cloudflare']), { cwd });
  assert.equal(resolved.live, 'https://example.test');
  assert.equal(resolved.dir, 'out');
  assert.equal(resolved.nonce, '__CSP_NONCE__');
  assert.equal(resolved.productionBranch, 'prod');
  const flagged = resolveCloudflareCommand(cloudflareOf(['cloudflare', '--live', 'https://other.test']), { cwd });
  assert.equal(flagged.live, 'https://other.test');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-empty-'));
  fs.writeFileSync(path.join(empty, 'package.json'), '{"name":"x","sitedrift":{}}');
  assert.throws(() => resolveCloudflareCommand(cloudflareOf(['cloudflare']), { cwd: empty }), /requires --live/);
  fs.writeFileSync(path.join(empty, 'package.json'), '{"sitedrift":{"lvie":"x"}}');
  assert.throws(() => resolveCloudflareCommand(cloudflareOf(['cloudflare']), { cwd: empty }), /Unknown config key/);
});

test('a boolean flag given an explicit value honors it', () => {
  const live = ['--live', 'https://example.test'];
  assert.equal(resolveConfig(['--open', ...live]).open, true);
  assert.equal(resolveConfig(['--open=false', ...live]).open, false);
  assert.equal(resolveConfig(['--https=1', ...live]).https, true);
  assert.equal(resolveConfig(['--https=0', ...live]).https, false);
  assert.throws(() => resolveConfig(['--open=maybe', ...live]), /--open must be true\/false or 1\/0/);
});

test('parses long, short, inline and negated options', () => {
  const { opts, positionals } = parseArgs(['/pricing', '-d', 'http://a.test', '--live=https://b.test', '-p=4200', '-o', '--no-https', '--', '--literal']);
  assert.deepEqual(opts, { dev: 'http://a.test', live: 'https://b.test', port: '4200', open: true, https: false });
  assert.deepEqual(positionals, ['/pricing', '--literal']);
  assert.equal(parseArgs(['-o=false']).opts.open, false);
  assert.equal(parseArgs(['-h']).opts.help, true);
});

test('reports unknown options and missing values by flag name', () => {
  assert.throws(() => parseArgs(['--wat']), /^Error: Unknown option: --wat$/);
  assert.throws(() => parseArgs(['-x']), /^Error: Unknown option: --x$/);
  assert.throws(() => parseArgs(['--wat=1']), /^Error: Unknown option: --wat$/);
  assert.throws(() => parseArgs(['--dev']), /^Error: Option --dev requires a value\.$/);
  assert.throws(() => parseArgs(['--dev', '--live', 'https://example.test']), /^Error: Option --dev requires a value\.$/);
  assert.equal(parseArgs(['--notes=-weird']).opts.notes, '-weird');
});

test('rejects project configuration values of the wrong type', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-types-'));
  const file = path.join(dir, 'sitedrift.config.json');
  fs.writeFileSync(file, JSON.stringify({ live: 'https://example.test', brand: 42 }));
  assert.throws(() => resolveConfig(['--config', file]), /brand must be a string/);
});
