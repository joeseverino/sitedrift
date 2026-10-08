import fs from 'node:fs';
import os from 'node:os';

import { readProjectConfig } from './config.ts';
import type { Side } from './frame-content.ts';

// Short flags and the boolean flags that never consume the next argument.
const ALIASES: Readonly<Record<string, string>> = { d: 'dev', l: 'live', p: 'port', o: 'open', h: 'help', v: 'version' };
const BOOLEAN_FLAGS = ['open', 'http', 'https', 'setup-https', 'help', 'version', 'js'] as const;
const VALUE_FLAGS = [
  'dev', 'live', 'port', 'host', 'hostname', 'cert', 'key', 'notes', 'brand', 'author',
  'vault', 'config', 'route', 'side', 'dir', 'production-branch', 'nonce',
] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type ValueFlag = (typeof VALUE_FLAGS)[number];

const booleanFlags: ReadonlySet<string> = new Set(BOOLEAN_FLAGS);
const valueFlags: ReadonlySet<string> = new Set(VALUE_FLAGS);

const isBooleanFlag = (name: string): name is BooleanFlag => booleanFlags.has(name);
const isValueFlag = (name: string): name is ValueFlag => valueFlags.has(name);

export type Options = { [K in BooleanFlag]?: boolean } & { [K in ValueFlag]?: string };

export interface ParsedArgs {
  opts: Options;
  positionals: string[];
}

function parseBoolean(value: string | boolean | undefined, name: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return false;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${name} must be true/false or 1/0.`);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const opts: Options = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (token[0] !== '-' || token === '-') { positionals.push(token); continue; }
    let arg = token.replace(/^--?/, '');
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const name = ALIASES[arg] ?? arg;
    if (isBooleanFlag(name)) {
      opts[name] = value === undefined ? true : parseBoolean(value, `--${name}`);
    } else if (isValueFlag(name)) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && next[0] !== '-') { value = next; i++; }
        else throw new Error(`Option --${name} requires a value.`);
      }
      opts[name] = value;
    } else {
      throw new Error(`Unknown option: --${arg}`);
    }
  }
  return { opts, positionals };
}

// SITEDRIFT_<NAME> is the public env var; SITE_COMPARE_<NAME> is the legacy name
// kept so the `site compare` wrapper keeps working after extraction.
function envVal(name: string): string | undefined {
  const v = process.env[`SITEDRIFT_${name}`] ?? process.env[`SITE_COMPARE_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

// Precedence for every setting: CLI flag > env > project config > built-in default.
function pick(opts: Options, fileConfig: Record<string, unknown>, flag: BooleanFlag | ValueFlag, name: string): unknown {
  return opts[flag] ?? envVal(name) ?? fileConfig[flag];
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${name} must be a string.`);
}

function flag(value: unknown, name: string): boolean {
  if (value === undefined || typeof value === 'boolean' || typeof value === 'string') {
    return parseBoolean(value, name);
  }
  throw new Error(`${name} must be true/false or 1/0.`);
}

export function cleanBase(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Site origins must be HTTP(S) URLs without credentials.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // Fall through to the placeholder below.
  }
  return '0.0.0';
}

export function printHelp() {
  console.log(`sitedrift: frame local dev against production, side by side on the same route.

Usage:
  sitedrift [path] [options]
  npx sitedrift /pricing --dev http://localhost:4321 --live https://example.com --open
  sitedrift status
  sitedrift context
  sitedrift mcp
  sitedrift cloudflare init --live https://example.com   (scaffold the Pages Function)
  sitedrift cloudflare --live https://example.com        (wrap a preview build)
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

Cloudflare options (sitedrift cloudflare):
      --live <url>               Production origin (HTTPS)       [required]
      --dir <dir>                Build output                    [auto-detected]
      --production-branch <name> Branch left untouched           [default main]
      --nonce <value>            CSP nonce or placeholder stamped on every tag sitedrift writes
      --brand <text>             Strip "| <text>" from titles
      --js                       init: write [[path]].js instead of .ts

Every option also reads SITEDRIFT_<NAME> (e.g. SITEDRIFT_DEV). Binds to
127.0.0.1 by default. It strips framing and isolation headers, so never expose it
publicly. See https://github.com/joeseverino/sitedrift`);
}

export interface ResolvedConfig {
  help: boolean;
  version: boolean;
  setupHttps: boolean;
  https: boolean;
  host: string;
  hostname: string;
  port: number;
  devBase: URL;
  liveBase: URL | undefined;
  certFile: string | undefined;
  keyFile: string | undefined;
  notesFile: string;
  brand: string;
  author: string;
  vaultDir: string;
  open: boolean;
  initialPath: string;
}

/** A config that has the production origin the server and the control commands need. */
export type ServerConfig = ResolvedConfig & { liveBase: URL };

export function requireLiveBase(config: ResolvedConfig): ServerConfig {
  if (!config.liveBase) {
    throw new Error('Missing production URL. Pass --live https://your-site.example or add "live" to sitedrift.config.json.');
  }
  return { ...config, liveBase: config.liveBase };
}

export function resolveConfig(
  argv: readonly string[] = process.argv.slice(2),
  { requireLive = true }: { requireLive?: boolean } = {},
): ResolvedConfig {
  const { opts, positionals } = parseArgs(argv);
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
  const fileConfig = readProjectConfig({ explicit: opts.config });
  const port = Number(pick(opts, fileConfig, 'port', 'PORT') ?? 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65533) {
    throw new Error('Port must be an integer from 1 to 65533 (the next two ports isolate DEV and LIVE).');
  }
  const certFile = opts.http ? undefined : text(pick(opts, fileConfig, 'cert', 'CERT'), 'cert');
  const keyFile = opts.http ? undefined : text(pick(opts, fileConfig, 'key', 'KEY'), 'key');
  if (!!certFile !== !!keyFile) throw new Error('--cert and --key must be provided together.');
  const host = text(pick(opts, fileConfig, 'host', 'HOST'), 'host') ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Host must be loopback (127.0.0.1, localhost, or ::1).');
  }
  const hostname = text(pick(opts, fileConfig, 'hostname', 'HOSTNAME'), 'hostname') ?? host;
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|::1)$/i.test(hostname)) {
    throw new Error('Hostname must be a valid DNS name or ::1.');
  }
  const live = text(pick(opts, fileConfig, 'live', 'LIVE'), 'live');
  if (requireLive && !opts.help && !opts.version && !opts['setup-https'] && !live) {
    throw new Error(
      'Missing production URL. Pass --live https://your-site.example '
      + 'or add "live" to sitedrift.config.json.',
    );
  }
  const [firstPath] = positionals;
  return {
    help: !!opts.help,
    version: !!opts.version,
    setupHttps: !!opts['setup-https'],
    https: !opts.http && flag(pick(opts, fileConfig, 'https', 'HTTPS'), 'https'),
    host,
    hostname,
    port,
    devBase: cleanBase(text(pick(opts, fileConfig, 'dev', 'DEV'), 'dev') ?? 'http://127.0.0.1:4321'),
    liveBase: live ? cleanBase(live) : undefined,
    certFile,
    keyFile,
    notesFile: text(pick(opts, fileConfig, 'notes', 'NOTES'), 'notes') ?? `${os.tmpdir()}/sitedrift-notes.json`,
    brand: text(pick(opts, fileConfig, 'brand', 'BRAND'), 'brand') ?? '',
    author: text(pick(opts, fileConfig, 'author', 'AUTHOR'), 'author') ?? 'you',
    vaultDir: text(pick(opts, fileConfig, 'vault', 'VAULT'), 'vault') ?? '',
    open: flag(pick(opts, fileConfig, 'open', 'OPEN'), 'open'),
    initialPath: firstPath ? '/' + firstPath.replace(/^\/+/, '') : '',
  };
}

export interface CloudflareCommand {
  name: 'cloudflare';
  action: 'wrap' | 'init';
  dir: string;
  live: string;
  brand: string;
  productionBranch: string;
  nonce: string;
  js: boolean;
  config: string | undefined;
}

interface NotesFields {
  name: 'notes';
  route: string | undefined;
  side: Side | undefined;
  author: string | undefined;
}

export type NotesCommand =
  | (NotesFields & { action: 'add'; text: string; id: undefined })
  | (NotesFields & { action: 'resolve' | 'reopen' | 'remove'; text: undefined; id: string })
  | (NotesFields & { action: 'list' | 'clear'; text: undefined; id: undefined });

export interface StatusCommand {
  name: 'status' | 'context';
}

export interface McpCommand {
  name: 'mcp';
}

/** Commands that talk to a running session. */
export type AgentCommand = StatusCommand | NotesCommand;

export type Command = McpCommand | CloudflareCommand | AgentCommand;

export interface ParsedCommand {
  command: Command;
  /** Arguments left over for {@link resolveConfig}. */
  argv: string[];
}

/** Fills a parsed `cloudflare` command from the project config. Flags win. */
export function resolveCloudflareCommand(
  command: CloudflareCommand,
  { cwd = process.cwd() }: { cwd?: string } = {},
): CloudflareCommand {
  const file = readProjectConfig({ explicit: command.config, cwd });
  const fromFile = (key: string): string => {
    const value = file[key];
    return typeof value === 'string' ? value : '';
  };
  const resolved: CloudflareCommand = {
    ...command,
    dir: command.dir || fromFile('dir'),
    live: command.live || fromFile('live'),
    brand: command.brand || fromFile('brand'),
    productionBranch: command.productionBranch || fromFile('productionBranch') || 'main',
    nonce: command.nonce || fromFile('nonce'),
  };
  // `init` only scaffolds the Function file, so --live is optional there.
  if (resolved.action === 'wrap' && !resolved.live) {
    throw new Error('sitedrift cloudflare requires --live (or "live" in sitedrift.config.json).');
  }
  return resolved;
}

const NOTES_ACTIONS = ['list', 'add', 'resolve', 'reopen', 'remove', 'clear'] as const;
type NotesAction = (typeof NOTES_ACTIONS)[number];
const isNotesAction = (value: string | undefined): value is NotesAction => NOTES_ACTIONS.some((action) => action === value);

function parseSide(value: string | undefined): Side | undefined {
  if (value === undefined) return undefined;
  if (value === 'dev' || value === 'live') return value;
  throw new Error('--side must be dev or live.');
}

export function parseCommand(argv: readonly string[] = process.argv.slice(2)): ParsedCommand | null {
  const name = argv[0];
  if (name === 'cloudflare') {
    const { opts, positionals } = parseArgs(argv.slice(1));
    const action = positionals[0] || 'wrap';
    if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`);
    if (action !== 'wrap' && action !== 'init') {
      throw new Error('Usage: sitedrift cloudflare [init] --live <url> [--dir <out>] [--nonce <value>] [--js]');
    }
    return {
      command: {
        name,
        action,
        dir: opts.dir || '',
        live: opts.live || '',
        brand: opts.brand || '',
        productionBranch: opts['production-branch'] || '',
        nonce: opts.nonce || '',
        js: !!opts.js,
        config: opts.config,
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
  if (name !== 'notes') return null;

  const action = argv[1];
  if (!isNotesAction(action)) {
    throw new Error('Usage: sitedrift notes list|add|resolve|reopen|remove|clear');
  }
  const tail = argv.slice(2);
  const needsSubject = action === 'add' || action === 'resolve' || action === 'reopen' || action === 'remove';
  const subject = needsSubject ? tail.shift() : undefined;
  if (needsSubject && !subject) throw new Error(`sitedrift notes ${action} requires ${action === 'add' ? 'text' : 'an id'}.`);
  const { opts, positionals } = parseArgs(tail);
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const fields: NotesFields = {
    name,
    route: opts.route,
    side: parseSide(opts.side),
    author: opts.author,
  };
  let command: NotesCommand;
  if (action === 'add') {
    command = { ...fields, action, text: subject ?? '', id: undefined };
  } else if (action === 'resolve' || action === 'reopen' || action === 'remove') {
    command = { ...fields, action, text: undefined, id: subject ?? '' };
  } else {
    command = { ...fields, action, text: undefined, id: undefined };
  }
  return { command, argv: tail };
}
