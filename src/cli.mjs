import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Short flags and the boolean flags that never consume the next argument.
const ALIASES = { d: 'dev', l: 'live', p: 'port', o: 'open', h: 'help', v: 'version' };
const BOOLEANS = new Set(['open', 'http', 'https', 'setup-https', 'help', 'version']);
const VALUE_FLAGS = new Set([
  'dev', 'live', 'port', 'host', 'hostname', 'cert', 'key', 'notes', 'brand', 'author',
  'vault', 'config', 'route', 'side', 'dir', 'production-branch',
]);
const KNOWN_FLAGS = new Set([...BOOLEANS, ...VALUE_FLAGS]);
const CONFIG_NAMES = ['sitedrift.config.json', '.sitedriftrc.json'];

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
    if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown option: --${arg}`);
    if (BOOLEANS.has(name)) { opts[name] = true; continue; }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && next[0] !== '-') { value = next; i++; }
      else throw new Error(`Option --${name} requires a value.`);
    }
    opts[name] = value;
  }
  return { opts, positionals };
}

function findConfigFile(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readConfigFile(explicit) {
  const file = explicit ? path.resolve(explicit) : findConfigFile();
  if (!file) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read config ${file}: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Config ${file} must contain a JSON object.`);
  }
  const allowed = new Set(['dev', 'live', 'port', 'host', 'hostname', 'cert', 'key', 'notes', 'brand', 'author', 'vault', 'https', 'open']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown config key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  return value;
}

// SITEDRIFT_<NAME> is the public env var; SITE_COMPARE_<NAME> is the legacy name
// kept so the `site compare` wrapper keeps working after extraction.
function envVal(name) {
  const v = process.env[`SITEDRIFT_${name}`] ?? process.env[`SITE_COMPARE_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

// Precedence for every setting: CLI flag > env > built-in default.
function pick(opts, fileConfig, flag, name, fallback) {
  return opts[flag] ?? envVal(name) ?? fileConfig[flag] ?? fallback;
}

function boolean(value, name) {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return false;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be true/false or 1/0.`);
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
  sitedrift status
  sitedrift context
  sitedrift mcp
  sitedrift cloudflare --dir dist --live https://example.com
  sitedrift notes list
  sitedrift notes add <text> [--route /path] [--side dev|live] [--author name]
  sitedrift notes resolve|reopen|remove <id>
  sitedrift notes clear

Options:
  -d, --dev <url>     Left-pane (dev) origin            [default http://127.0.0.1:4321]
  -l, --live <url>    Right-pane (live) origin          [required]
  -p, --port <n>      Listen port                       [default 4178]
      --host <addr>   Bind address                      [default 127.0.0.1]
      --hostname <n>  Browser hostname                  [default bind address]
  -o, --open          Open the viewer in your browser
      --https         Serve HTTPS with an auto cert (mkcert if present, else openssl)
      --setup-https   One-time: generate + trust a local cert, then exit
      --http          Force plain HTTP (the default; overrides --https)
      --cert <file>   TLS cert (serve HTTPS; needs --key)
      --key <file>    TLS key
      --notes <file>  Shared review-notes JSON          [default \$TMPDIR/sitedrift-notes.json]
      --brand <text>  Strip "| <text>" from pane-header titles
      --author <name> Byline for notes added in the viewer
      --vault <dir>   Enable "Send to vault" (writes review markdown here)
      --config <file> Read project configuration from a JSON file
  -h, --help          Show this help
  -v, --version       Print version

Every option also reads SITEDRIFT_<NAME> (e.g. SITEDRIFT_DEV). Binds to
127.0.0.1 by default — it strips framing/isolation headers, so never expose it
publicly. See https://github.com/joeseverino/sitedrift`);
}

export function resolveConfig(argv = process.argv.slice(2), { requireLive = true } = {}) {
  const { opts, positionals } = parseArgs(argv);
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  const fileConfig = readConfigFile(opts.config);
  const port = Number(pick(opts, fileConfig, 'port', 'PORT', 4178));
  if (!Number.isInteger(port) || port < 1 || port > 65533) {
    throw new Error('Port must be an integer from 1 to 65533 (the next two ports isolate DEV and LIVE).');
  }
  const certFile = opts.http ? undefined : pick(opts, fileConfig, 'cert', 'CERT', undefined);
  const keyFile = opts.http ? undefined : pick(opts, fileConfig, 'key', 'KEY', undefined);
  if (!!certFile !== !!keyFile) throw new Error('--cert and --key must be provided together.');
  const host = pick(opts, fileConfig, 'host', 'HOST', '127.0.0.1');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Host must be loopback (127.0.0.1, localhost, or ::1).');
  }
  const hostname = pick(opts, fileConfig, 'hostname', 'HOSTNAME', host);
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|::1)$/i.test(hostname)) {
    throw new Error('Hostname must be a valid DNS name or ::1.');
  }
  const live = pick(opts, fileConfig, 'live', 'LIVE', undefined);
  if (requireLive && !opts.help && !opts.version && !opts['setup-https'] && !live) {
    throw new Error(
      'Missing production URL. Pass --live https://your-site.example '
      + 'or add "live" to sitedrift.config.json.',
    );
  }
  return {
    opts,
    help: !!opts.help,
    version: !!opts.version,
    setupHttps: !!opts['setup-https'],
    https: !opts.http && boolean(pick(opts, fileConfig, 'https', 'HTTPS', false), 'https'),
    host,
    hostname,
    port,
    devBase: cleanBase(pick(opts, fileConfig, 'dev', 'DEV', 'http://127.0.0.1:4321')),
    liveBase: live ? cleanBase(live) : undefined,
    certFile,
    keyFile,
    notesFile: pick(opts, fileConfig, 'notes', 'NOTES', `${os.tmpdir()}/sitedrift-notes.json`),
    brand: pick(opts, fileConfig, 'brand', 'BRAND', ''),
    author: pick(opts, fileConfig, 'author', 'AUTHOR', 'you'),
    vaultDir: pick(opts, fileConfig, 'vault', 'VAULT', ''),
    open: boolean(pick(opts, fileConfig, 'open', 'OPEN', false), 'open'),
    initialPath: positionals[0]
      ? '/' + String(positionals[0]).replace(/^\/+/, '')
      : '',
  };
}

export function parseCommand(argv = process.argv.slice(2)) {
  const name = argv[0];
  if (!['status', 'context', 'notes', 'mcp', 'cloudflare'].includes(name)) return null;
  if (name === 'cloudflare') {
    const { opts, positionals } = parseArgs(argv.slice(1));
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    if (!opts.live) throw new Error('sitedrift cloudflare requires --live.');
    return {
      command: {
        name,
        dir: opts.dir || 'dist',
        live: opts.live,
        brand: opts.brand || '',
        productionBranch: opts['production-branch'] || 'main',
      },
      argv: [],
    };
  }
  if (name === 'mcp') {
    if (argv.length > 1) throw new Error('Usage: sitedrift mcp');
    return { command: { name }, argv: [] };
  }
  if (name === 'status' || name === 'context') {
    return { command: { name }, argv: argv.slice(1) };
  }
  const action = argv[1];
  if (!['list', 'add', 'resolve', 'reopen', 'remove', 'clear'].includes(action)) {
    throw new Error('Usage: sitedrift notes list|add|resolve|reopen|remove|clear');
  }
  const tail = argv.slice(2);
  let subject;
  if (action === 'add' || ['resolve', 'reopen', 'remove'].includes(action)) {
    subject = tail.shift();
    if (!subject) throw new Error(`sitedrift notes ${action} requires ${action === 'add' ? 'text' : 'an id'}.`);
  }
  const { opts, positionals } = parseArgs(tail);
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  if (opts.side && !['dev', 'live'].includes(opts.side)) throw new Error('--side must be dev or live.');
  return {
    command: {
      name,
      action,
      text: action === 'add' ? subject : undefined,
      id: action === 'add' ? undefined : subject,
      route: opts.route,
      side: opts.side,
      author: opts.author,
    },
    argv: tail,
  };
}
