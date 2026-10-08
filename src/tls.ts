import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Cached auto-generated cert lives here so --https is instant after the first run
// and a mkcert-trusted CA only has to be installed once.
const CERT_DIR = path.join(os.homedir(), '.sitedrift');
const CERT_FILE = path.join(CERT_DIR, 'localhost.pem');
const KEY_FILE = path.join(CERT_DIR, 'localhost-key.pem');
const HOSTS = ['localhost', '127.0.0.1', '::1'];

function have(cmd: string, probe: string): boolean {
  try {
    return !spawnSync(cmd, [probe], { stdio: 'ignore' }).error;
  } catch {
    return false;
  }
}
const hasMkcert = () => have('mkcert', '-CAROOT');
const hasOpenssl = () => have('openssl', 'version');

function generateWithMkcert(quiet: boolean): void {
  const stdio = quiet ? 'ignore' : 'inherit';
  // -install is idempotent; first run may prompt for the OS trust store.
  spawnSync('mkcert', ['-install'], { stdio });
  const r = spawnSync('mkcert', ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...HOSTS], { stdio });
  if (r.status !== 0) throw new Error('mkcert failed to generate a certificate.');
}

function generateWithOpenssl(): void {
  const san = HOSTS.map((h) => (/^[\d.:]+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_FILE, '-out', CERT_FILE,
    '-days', '825', '-subj', '/CN=localhost',
    '-addext', `subjectAltName=${san}`,
  ], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('openssl failed to generate a certificate.');
  fs.chmodSync(KEY_FILE, 0o600);
}

const NO_TOOL_MESSAGE = 'sitedrift --https needs `mkcert` (recommended) or `openssl`.\n'
  + '  Install mkcert for zero-warning HTTPS: https://github.com/FiloSottile/mkcert#installation\n'
  + '  (macOS: brew install mkcert · then run: sitedrift --setup-https)\n'
  + '  Or bring your own cert: sitedrift --cert <file> --key <file>';

interface EnsuredCert {
  certFile: string;
  keyFile: string;
  source: 'cache' | 'mkcert' | 'openssl';
}

function ensureCert({ quiet = true, force = false } = {}): EnsuredCert {
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  if (!force && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { certFile: CERT_FILE, keyFile: KEY_FILE, source: 'cache' };
  }
  if (hasMkcert()) {
    generateWithMkcert(quiet);
    return { certFile: CERT_FILE, keyFile: KEY_FILE, source: 'mkcert' };
  }
  if (hasOpenssl()) {
    generateWithOpenssl();
    return { certFile: CERT_FILE, keyFile: KEY_FILE, source: 'openssl' };
  }
  throw new Error(NO_TOOL_MESSAGE);
}

function trustSteps(certFile: string): string {
  const steps: Record<string, string> = {
    darwin: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certFile}"`,
    linux: `sudo cp "${certFile}" /usr/local/share/ca-certificates/sitedrift.crt && sudo update-ca-certificates`,
    win32: `certutil -addstore -f ROOT "${certFile}"`,
  };
  const here = steps[process.platform];
  return here
    ? `Trust it on this machine:\n   ${here}\n   (or just click through the browser warning each run)`
    : 'Your browser will warn once — click Advanced → Proceed, or trust the cert in your OS store.';
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

// Used by the server: resolve { cert, key } buffers, or null for plain HTTP.
export function resolveTls(config: { certFile?: string | undefined; keyFile?: string | undefined; https: boolean }): TlsMaterial | null {
  if (config.certFile && config.keyFile) {
    return { cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) };
  }
  if (config.https) {
    const c = ensureCert({ quiet: true });
    if (c.source === 'openssl') {
      console.log('sitedrift: generated a self-signed cert (browser will warn).');
      console.log('  For zero warnings: sitedrift --setup-https  (needs mkcert)\n');
    }
    return { cert: fs.readFileSync(c.certFile), key: fs.readFileSync(c.keyFile) };
  }
  return null;
}

// Used by `sitedrift --setup-https`: generate + trust, with guided output.
export function setupHttps(): number {
  console.log('sitedrift — HTTPS setup\n');
  if (hasMkcert()) {
    console.log('Found mkcert — generating a locally-trusted certificate.\n');
    const c = ensureCert({ quiet: false, force: true });
    console.log(`\n✓ Local CA installed and trusted cert written:\n   ${c.certFile}`);
    console.log('\nStart with HTTPS (no browser warning):\n   sitedrift --https');
    return 0;
  }
  if (hasOpenssl()) {
    console.log('mkcert not found — using openssl for a self-signed cert.');
    console.log('Tip: `brew install mkcert` gives zero-warning HTTPS instead.\n');
    const c = ensureCert({ quiet: false, force: true });
    console.log(`✓ Self-signed cert written:\n   ${c.certFile}\n`);
    console.log(trustSteps(c.certFile));
    console.log('\nThen start: sitedrift --https');
    return 0;
  }
  console.error(NO_TOOL_MESSAGE);
  return 1;
}
