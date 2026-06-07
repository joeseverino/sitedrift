import { readVersion } from './cli.mjs';
import { requestSession } from './agent.mjs';
import { readSession } from './session.mjs';

const PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);
const LATEST_PROTOCOL_VERSION = '2025-11-25';

const TOOLS = [
  {
    name: 'sitedrift_context',
    title: 'Get sitedrift session context',
    description: 'Get the active DEV/LIVE targets, viewer URL, capabilities, and session metadata. Call this first.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65533, default: 4178 },
      },
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
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65533, default: 4178 },
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
        port: { type: 'integer', minimum: 1, maximum: 65533, default: 4178 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ...['resolve', 'reopen', 'remove'].map((action) => ({
    name: `sitedrift_note_${action}`,
    title: `${action[0].toUpperCase()}${action.slice(1)} a review note`,
    description: `${action[0].toUpperCase()}${action.slice(1)} one shared review note by ID.`,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65533, default: 4178 },
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
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65533, default: 4178 },
      },
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

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function setupInstructions(args = {}) {
  const dev = args.dev || 'http://localhost:4321';
  const live = args.live || 'https://example.com';
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

function noteOperation(name, args) {
  if (name === 'sitedrift_note_add') {
    return {
      op: 'add',
      text: args.text,
      route: args.route || '/',
      side: args.side || null,
      author: args.author || 'agent',
    };
  }
  if (name === 'sitedrift_notes_clear') return { op: 'clear' };
  return { op: name.replace('sitedrift_note_', ''), id: args.id };
}

async function callTool(name, args = {}) {
  if (name === 'sitedrift_setup') return setupInstructions(args);
  const session = readSession(args.port || 4178);
  if (name === 'sitedrift_context') return requestSession(session, '/api/v1/session');
  if (name === 'sitedrift_notes_list') return requestSession(session, '/api/v1/notes');
  if (!TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`);
  return requestSession(session, '/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(noteOperation(name, args)),
  });
}

function guideText() {
  return `# sitedrift agent workflow

1. Call sitedrift_context before doing review work.
2. Use the returned viewer URL and DEV/LIVE targets as the source of truth.
3. Record one concrete issue per sitedrift_note_add call. Include the route and side.
4. Re-list notes before changing code and after verification.
5. Resolve a note only after verifying the fix; remove notes only when explicitly asked.
6. If no session is running, call sitedrift_setup and help the user create sitedrift.config.json, then launch sitedrift.

The MCP server never receives browser credentials and only talks to a loopback sitedrift session using its private mode-0600 descriptor.`;
}

function promptResult(args = {}) {
  const route = args.route || '/';
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

export async function handleMcpRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    if (requested && !PROTOCOL_VERSIONS.has(requested)) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Unsupported protocol version',
          data: { supported: [...PROTOCOL_VERSIONS], requested },
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'sitedrift', version: readVersion() },
        instructions: 'Call sitedrift_context first. If no session is running, call sitedrift_setup.',
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      return { jsonrpc: '2.0', id, result: jsonResult(await callTool(params.name, params.arguments)) };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        },
      };
    }
  }
  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          { uri: 'sitedrift://guide', name: 'Agent guide', mimeType: 'text/markdown' },
          { uri: 'sitedrift://session', name: 'Active session', mimeType: 'application/json' },
          { uri: 'sitedrift://notes', name: 'Review notes', mimeType: 'application/json' },
        ],
      },
    };
  }
  if (method === 'resources/read') {
    try {
      let text;
      let mimeType = 'application/json';
      if (params.uri === 'sitedrift://guide') {
        text = guideText();
        mimeType = 'text/markdown';
      } else {
        const session = readSession(4178);
        const pathname = params.uri === 'sitedrift://session'
          ? '/api/v1/session'
          : params.uri === 'sitedrift://notes'
            ? '/api/v1/notes'
            : null;
        if (!pathname) throw new Error(`Unknown resource: ${params.uri}`);
        text = JSON.stringify(await requestSession(session, pathname), null, 2);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri: params.uri, mimeType, text }] },
      };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: error.message } };
    }
  }
  if (method === 'prompts/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        prompts: [{
          name: 'review_route',
          title: 'Review a route',
          description: 'Compare one route and record actionable findings.',
          arguments: [{ name: 'route', description: 'Route to review, such as /pricing.', required: false }],
        }],
      },
    };
  }
  if (method === 'prompts/get') {
    if (params.name !== 'review_route') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params.name}` } };
    }
    return { jsonrpc: '2.0', id, result: promptResult(params.arguments) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function processMessage(message) {
  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map(handleMcpRequest))).filter(Boolean);
    return responses.length ? responses : null;
  }
  return handleMcpRequest(message);
}

export function runMcpServer(input = process.stdin, output = process.stdout) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      Promise.resolve()
        .then(() => JSON.parse(line))
        .then(processMessage)
        .then((response) => {
          if (response) output.write(`${JSON.stringify(response)}\n`);
        })
        .catch((error) => {
          output.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: error.message },
          })}\n`);
        });
    }
  });
}
