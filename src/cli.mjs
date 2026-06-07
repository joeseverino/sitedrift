import fs from 'node:fs';
import os from 'node:os';

// Short flags and the boolean flags that never consume the next argument.
const ALIASES = { d: 'dev', l: 'live', p: 'port', o: 'open', h: 'help', v: 'version' };
const BOOLEANS = new Set(['open', 'http', 'help', 'version']);

export function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg[0] !== '-' || arg === '-') { positionals.push(arg); continue; }
    arg = arg.replace(/^--?/, '');
    let value;
    const eq = arg.indexOf('=');
    if (eq !== -1) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const name = ALIASES[arg] || arg;
    if (BOOLEANS.has(name)) { opts[name] = true; continue; }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && next[0] !== '-') { value = next; i++; }
      else value = true;
    }
    opts[name] = value;
  }
  return { opts, positionals };
}

// SITEDRIFT_<NAME> is the public env var; SITE_COMPARE_<NAME> is the legacy name
// kept so the `site compare` wrapper keeps working after extraction.
function envVal(name) {
  const v = process.env[`SITEDRIFT_${name}`] ?? process.env[`SITE_COMPARE_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

// Precedence for every setting: CLI flag > env > built-in default.
function pick(opts, flag, name, fallback) {
  return opts[flag] ?? envVal(name) ?? fallback;
}

export function cleanBase(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch { return '0.0.0'; }
}

export function printHelp() {
  console.log(`sitedrift — frame local dev against production, side-by-side on the same route.

Usage:
  sitedrift [path] [options]
  npx sitedrift /pricing --dev http://localhost:4321 --live https://example.com --open

Options:
  -d, --dev <url>     Left-pane (dev) origin            [default http://127.0.0.1:4321]
  -l, --live <url>    Right-pane (live) origin          [default https://example.com]
  -p, --port <n>      Listen port                       [default 4178]
      --host <addr>   Bind address                      [default 127.0.0.1]
  -o, --open          Open the viewer in your browser
      --http          Force plain HTTP (ignore --cert/--key)
      --cert <file>   TLS cert (serve HTTPS; needs --key)
      --key <file>    TLS key
      --notes <file>  Shared review-notes JSON          [default \$TMPDIR/sitedrift-notes.json]
      --brand <text>  Strip "| <text>" from pane-header titles
      --author <name> Byline for notes added in the viewer
      --vault <dir>   Enable "Send to vault" (writes review markdown here)
  -h, --help          Show this help
  -v, --version       Print version

Every option also reads SITEDRIFT_<NAME> (e.g. SITEDRIFT_DEV). Binds to
127.0.0.1 by default — it strips framing/isolation headers, so never expose it
publicly. See https://github.com/joeseverino/sitedrift`);
}

export function resolveConfig(argv = process.argv.slice(2)) {
  const { opts, positionals } = parseArgs(argv);
  return {
    opts,
    help: !!opts.help,
    version: !!opts.version,
    host: pick(opts, 'host', 'HOST', '127.0.0.1'),
    port: Number(pick(opts, 'port', 'PORT', 4178)),
    devBase: cleanBase(pick(opts, 'dev', 'DEV', 'http://127.0.0.1:4321')),
    liveBase: cleanBase(pick(opts, 'live', 'LIVE', 'https://example.com')),
    certFile: opts.http ? undefined : pick(opts, 'cert', 'CERT', undefined),
    keyFile: opts.http ? undefined : pick(opts, 'key', 'KEY', undefined),
    notesFile: pick(opts, 'notes', 'NOTES', `${os.tmpdir()}/sitedrift-notes.json`),
    brand: pick(opts, 'brand', 'BRAND', ''),
    author: pick(opts, 'author', 'AUTHOR', 'you'),
    vaultDir: pick(opts, 'vault', 'VAULT', ''),
    open: !!opts.open,
    initialPath: positionals[0]
      ? '/' + String(positionals[0]).replace(/^\/+/, '')
      : '',
  };
}
