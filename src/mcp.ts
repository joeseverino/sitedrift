import { readVersion } from './cli.ts';
import { requestSession } from './agent.ts';
import type { NoteOperation } from './notes.ts';
import { readSession } from './session.ts';
import type { Session } from './session.ts';
import type { Side } from './wire.ts';

const PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_PORT = 4178;
const MAX_PORT = 65533;

export type JsonRpcId = string | number | null;

export interface McpRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: true;
}

export type McpResult =
  | Record<string, never>
  | { protocolVersion: string; capabilities: Record<string, Record<string, never>>; serverInfo: { name: string; version: string }; instructions: string }
  | { tools: McpTool[] }
  | ToolResult
  | { resources: { uri: string; name: string; mimeType: string }[] }
  | { contents: { uri: string; mimeType: string; text: string }[] }
  | { prompts: { name: string; title: string; description: string; arguments: { name: string; description: string; required: boolean }[] }[] }
  | { description: string; messages: { role: 'user'; content: { type: 'text'; text: string } }[] };

export type McpResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: McpResult }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

const portProperty = { type: 'integer', minimum: 1, maximum: MAX_PORT, default: DEFAULT_PORT };

const NOTE_ACTIONS = ['resolve', 'reopen', 'remove'] as const;

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const TOOLS: McpTool[] = [
  {
    name: 'sitedrift_context',
    title: 'Get sitedrift session context',
    description: 'Get the active DEV/LIVE targets, viewer URL, capabilities, and session metadata. Call this first.',
    inputSchema: {
      type: 'object',
      properties: { port: portProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'sitedrift_notes_list',
    title: 'List review notes',
    description: 'List the current shared visual-review notes.',
    inputSchema: {
      type: 'object',
      properties: { port: portProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'sitedrift_notes_watch',
    title: 'Watch review notes',
    description: 'Wait for shared review notes to change. Pass the revision from notes_list to avoid a race; without one, watch from the current state.',
    inputSchema: {
      type: 'object',
      properties: {
        revision: { type: 'string', minLength: 1, description: 'Opaque revision returned by sitedrift_notes_list or a previous watch.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 55000, default: 25000 },
        port: portProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'sitedrift_note_add',
    title: 'Add a review note',
    description: 'Add one concrete visual finding for the user or another agent.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        route: { type: 'string', default: '/' },
        side: { type: ['string', 'null'], enum: ['dev', 'live', null] },
        author: { type: 'string', default: 'agent' },
        port: portProperty,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ...NOTE_ACTIONS.map((action): McpTool => ({
    name: `sitedrift_note_${action}`,
    title: `${capitalize(action)} a review note`,
    description: `${capitalize(action)} one shared review note by ID.`,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        port: portProperty,
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: action === 'remove',
      idempotentHint: action !== 'remove',
      openWorldHint: false,
    },
  })),
  {
    name: 'sitedrift_notes_clear',
    title: 'Clear all review notes',
    description: 'Delete every note in the active review session. Use only when the user explicitly requests it.',
    inputSchema: {
      type: 'object',
      properties: { port: portProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sitedrift_setup',
    title: 'Get setup instructions',
    description: 'Return the shortest install, project configuration, launch, HTTPS, and MCP-client setup instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        dev: { type: 'string', description: 'Local development origin.' },
        live: { type: 'string', description: 'Production origin.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${key} must be a string.`);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function portArg(args: Record<string, unknown>): number {
  const { port } = args;
  if (port === undefined) return DEFAULT_PORT;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= MAX_PORT) return port;
  throw new Error(`port must be an integer from 1 to ${MAX_PORT}.`);
}

function setupInstructions(args: Record<string, unknown>) {
  const dev = optionalString(args, 'dev') || 'http://localhost:4321';
  const live = optionalString(args, 'live') || 'https://example.com';
  return {
    install: 'npm install --global sitedrift',
    configFile: 'sitedrift.config.json',
    config: { dev, live, open: true },
    launch: 'sitedrift',
    https: ['sitedrift --setup-https', 'sitedrift --https'],
    mcp: {
      command: 'sitedrift-mcp',
      alternative: 'npx -y sitedrift mcp',
      config: { command: 'sitedrift-mcp', args: [] },
    },
    firstTool: 'sitedrift_context',
    guide: 'Read the packaged AGENTS.md or the sitedrift://guide MCP resource.',
  };
}

function noteOperation(name: string, args: Record<string, unknown>): NoteOperation {
  if (name === 'sitedrift_note_add') {
    const side = args.side ?? null;
    if (side !== null && side !== 'dev' && side !== 'live') throw new Error('side must be "dev", "live", or null.');
    return {
      op: 'add',
      text: requiredString(args, 'text'),
      route: optionalString(args, 'route') || '/',
      side,
      author: optionalString(args, 'author') || 'agent',
    };
  }
  if (name === 'sitedrift_notes_clear') return { op: 'clear' };
  const action = NOTE_ACTIONS.find((candidate) => name === `sitedrift_note_${candidate}`);
  if (!action) throw new Error(`Unknown tool: ${name}`);
  return { op: action, id: requiredString(args, 'id') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NotesPayload {
  revision: string;
  notes: readonly unknown[];
}

function isNotesPayload(value: unknown): value is NotesPayload {
  return typeof value === 'object' && value !== null
    && 'revision' in value && typeof value.revision === 'string'
    && 'notes' in value && Array.isArray(value.notes);
}

export type WatchResult =
  | { changed: false; revision: string }
  | { changed: true; revision: string; notes: readonly unknown[] };

export async function watchNotes(
  session: Session,
  { revision, timeoutMs = 25000 }: { revision?: string | undefined; timeoutMs?: number } = {},
  { request = requestSession, intervalMs = 250 }: {
    request?: (session: Session, pathname: string) => Promise<unknown>;
    intervalMs?: number;
  } = {},
): Promise<WatchResult> {
  const timeout = Math.min(55000, Math.max(1000, timeoutMs));
  const deadline = Date.now() + timeout;
  const read = async (): Promise<NotesPayload> => {
    const value = await request(session, '/api/v1/notes');
    if (!isNotesPayload(value)) throw new Error('Unexpected response from the sitedrift notes API.');
    return value;
  };
  let current = await read();
  const baseline = revision || current.revision;

  while (current.revision === baseline && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    current = await read();
  }

  if (current.revision === baseline) return { changed: false, revision: current.revision };
  return { changed: true, revision: current.revision, notes: current.notes };
}

function watchOptions(args: Record<string, unknown>): { revision: string | undefined; timeoutMs?: number } {
  const { timeoutMs } = args;
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') throw new Error('timeoutMs must be a number.');
  return { revision: optionalString(args, 'revision'), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
  if (name === 'sitedrift_setup') return setupInstructions(args);
  // Validate the arguments before looking for a session, so a bad call is reported as one.
  const port = portArg(args);
  if (name === 'sitedrift_context') return requestSession(readSession(port), '/api/v1/session');
  if (name === 'sitedrift_notes_list') return requestSession(readSession(port), '/api/v1/notes');
  if (name === 'sitedrift_notes_watch') {
    const options = watchOptions(args);
    return watchNotes(readSession(port), options);
  }
  const operation = noteOperation(name, args);
  return requestSession(readSession(port), '/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(operation),
  });
}

function guideText(): string {
  return `# sitedrift agent workflow

1. Call sitedrift_context before doing review work.
2. Use the returned viewer URL and DEV/LIVE targets as the source of truth.
3. Record one concrete issue per sitedrift_note_add call. Include the route and side.
4. Re-list notes before changing code and after verification.
5. Resolve a note only after verifying the fix; remove notes only when explicitly asked.
6. If no session is running and shell access is available, inspect the project for its dev command and existing sitedrift wrapper/config, start both, then retry sitedrift_context.
7. Use sitedrift_setup only when you cannot launch the project yourself. Prefer project-local HTTPS, hostname, certificate, and port conventions over generic loopback defaults.

The MCP server never receives browser credentials and only talks to a loopback sitedrift session using its private mode-0600 descriptor.`;
}

function promptResult(args: Record<string, unknown>): McpResult {
  const route = optionalString(args, 'route') || '/';
  return {
    description: 'Review one route with sitedrift and leave actionable shared notes.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review ${route} with sitedrift. Call sitedrift_context first, inspect DEV and LIVE, add one specific note per discrepancy, avoid duplicates, and resolve notes only after verification.`,
      },
    }],
  };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Answers one JSON-RPC message. Notifications (no id) and the `notifications/*` methods get no response. */
export async function handleMcpRequest(message: McpRequest): Promise<McpResponse | null> {
  const response = await respond(message);
  return message.id === undefined ? null : response;
}

async function respond(message: McpRequest): Promise<McpResponse | null> {
  const { method, params = {} } = message;
  const id = message.id ?? null;
  const result = (value: McpResult): McpResponse => ({ jsonrpc: '2.0', id, result: value });
  const failure = (code: number, text: string, data?: unknown): McpResponse => ({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message: text } : { code, message: text, data },
  });

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return result({});
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    if (typeof requested === 'string' && requested && !PROTOCOL_VERSIONS.has(requested)) {
      return failure(-32602, 'Unsupported protocol version', { supported: [...PROTOCOL_VERSIONS], requested });
    }
    return result({
      protocolVersion: (typeof requested === 'string' && requested) || LATEST_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'sitedrift', version: readVersion() },
      instructions: 'Call sitedrift_context first. If no session is running, call sitedrift_setup.',
    });
  }
  if (method === 'tools/list') return result({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      return result(jsonResult(await callTool(name, args)));
    } catch (error) {
      return result({ content: [{ type: 'text', text: errorMessage(error) }], isError: true });
    }
  }
  if (method === 'resources/list') {
    return result({
      resources: [
        { uri: 'sitedrift://guide', name: 'Agent guide', mimeType: 'text/markdown' },
        { uri: 'sitedrift://session', name: 'Active session', mimeType: 'application/json' },
        { uri: 'sitedrift://notes', name: 'Review notes', mimeType: 'application/json' },
      ],
    });
  }
  if (method === 'resources/read') {
    const uri = typeof params.uri === 'string' ? params.uri : '';
    try {
      if (uri === 'sitedrift://guide') {
        return result({ contents: [{ uri, mimeType: 'text/markdown', text: guideText() }] });
      }
      const pathname = uri === 'sitedrift://session'
        ? '/api/v1/session'
        : uri === 'sitedrift://notes'
          ? '/api/v1/notes'
          : null;
      if (!pathname) throw new Error(`Unknown resource: ${uri}`);
      const text = JSON.stringify(await requestSession(readSession(DEFAULT_PORT), pathname), null, 2);
      return result({ contents: [{ uri, mimeType: 'application/json', text }] });
    } catch (error) {
      return failure(-32002, errorMessage(error));
    }
  }
  if (method === 'prompts/list') {
    return result({
      prompts: [{
        name: 'review_route',
        title: 'Review a route',
        description: 'Compare one route and record actionable findings.',
        arguments: [{ name: 'route', description: 'Route to review, such as /pricing.', required: false }],
      }],
    });
  }
  if (method === 'prompts/get') {
    if (params.name !== 'review_route') return failure(-32602, `Unknown prompt: ${String(params.name)}`);
    return result(promptResult(isRecord(params.arguments) ? params.arguments : {}));
  }
  return failure(-32601, `Method not found: ${method}`);
}

function parseRequest(value: unknown): McpRequest | null {
  if (!isRecord(value) || typeof value.method !== 'string') return null;
  const { id, params } = value;
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return null;
  return {
    method: value.method,
    ...(id === undefined ? {} : { id }),
    ...(isRecord(params) ? { params } : {}),
  };
}

const invalidRequest = (): McpResponse => ({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'Invalid Request' },
});

async function processMessage(message: unknown): Promise<McpResponse | McpResponse[] | null> {
  if (Array.isArray(message)) {
    if (!message.length) return invalidRequest();
    const responses = await Promise.all(message.map(async (item: unknown) => {
      const request = parseRequest(item);
      return request ? handleMcpRequest(request) : invalidRequest();
    }));
    const answered = responses.filter((response): response is McpResponse => response !== null);
    return answered.length ? answered : null;
  }
  const request = parseRequest(message);
  return request ? handleMcpRequest(request) : invalidRequest();
}

export function runMcpServer(
  input: Pick<NodeJS.ReadableStream, 'setEncoding' | 'on'> = process.stdin,
  output: Pick<NodeJS.WritableStream, 'write'> = process.stdout,
): void {
  let buffer = '';
  const write = (value: unknown): void => { output.write(`${JSON.stringify(value)}\n`); };
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: errorMessage(error) } });
        continue;
      }
      processMessage(message)
        .then((response) => { if (response) write(response); })
        .catch((error: unknown) => {
          write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: errorMessage(error) } });
        });
    }
  });
}
