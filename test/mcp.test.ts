import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { handleMcpRequest, runMcpServer, watchNotes } from '../src/mcp.ts';
import type { McpResult } from '../src/mcp.ts';
import type { Session } from '../src/session.ts';

async function call(method: string, params?: Record<string, unknown>, id = 1): Promise<McpResult> {
  const response = await handleMcpRequest({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  assert.ok(response, `${method} answers`);
  assert.ok('result' in response, `${method} succeeds: ${JSON.stringify(response)}`);
  return response.result;
}

test('MCP initializes and advertises the compact tool surface', async () => {
  const initialized = await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.partialDeepStrictEqual(initialized, {
    protocolVersion: '2025-11-25',
    serverInfo: { name: 'sitedrift' },
  });

  const listed = await call('tools/list');
  assert.ok('tools' in listed);
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes('sitedrift_context'));
  assert.ok(names.includes('sitedrift_notes_watch'));
  assert.ok(names.includes('sitedrift_note_add'));
  assert.ok(names.includes('sitedrift_setup'));
});

test('MCP notes watch returns only after the revision changes', async () => {
  let calls = 0;
  const session: Session = {
    version: 1,
    pid: process.pid,
    url: 'http://127.0.0.1:4178',
    frameUrls: { dev: 'http://127.0.0.1:4179', live: 'http://127.0.0.1:4180' },
    token: 'secret',
    dev: 'http://127.0.0.1:4321',
    live: 'https://example.test',
    notesFile: '/tmp/notes.json',
    startedAt: new Date().toISOString(),
  };
  const responses = [
    { revision: 'old', notes: [] },
    { revision: 'new', notes: [{ id: '1', text: 'changed' }] },
  ];
  const request = async (): Promise<unknown> => responses[Math.min(calls++, responses.length - 1)];

  const result = await watchNotes(
    session,
    {
      revision: 'old',
      timeoutMs: 1000,
    },
    { request, intervalMs: 0 },
  );
  assert.deepEqual(result, {
    changed: true,
    revision: 'new',
    notes: [{ id: '1', text: 'changed' }],
  });
});

test('MCP setup works before a sitedrift session exists', async () => {
  const response = await call('tools/call', {
    name: 'sitedrift_setup',
    arguments: { dev: 'http://localhost:3000', live: 'https://example.test' },
  }, 3);
  assert.partialDeepStrictEqual(response, {
    structuredContent: {
      config: { dev: 'http://localhost:3000' },
      mcp: { command: 'sitedrift-mcp' },
    },
  });
});

test('MCP exposes a short operational guide and review prompt', async () => {
  const resource = await call('resources/read', { uri: 'sitedrift://guide' }, 4);
  assert.ok('contents' in resource);
  assert.match(resource.contents[0]?.text ?? '', /Call sitedrift_context before/);

  const prompt = await call('prompts/get', { name: 'review_route', arguments: { route: '/pricing' } }, 5);
  assert.ok('messages' in prompt);
  assert.match(prompt.messages[0]?.content.text ?? '', /\/pricing/);
});

async function toolError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call('tools/call', { name, arguments: args });
  assert.ok('isError' in result && result.isError, `${name} is rejected`);
  return result.content[0]?.text ?? '';
}

test('MCP rejects an unknown tool or a bad argument before it looks for a session', async () => {
  assert.equal(await toolError('sitedrift_nope', {}), 'Unknown tool: sitedrift_nope');
  assert.match(await toolError('sitedrift_context', { port: 'abc' }), /port must be an integer/);
  assert.match(await toolError('sitedrift_note_add', { text: 42 }), /text must be a string/);
  assert.match(await toolError('sitedrift_note_add', { text: 'x', side: 'both' }), /side must be/);
  assert.match(await toolError('sitedrift_note_resolve', {}), /id is required/);
});

test('MCP answers requests and never answers notifications', async () => {
  assert.equal(await handleMcpRequest({ method: 'notifications/roots/list_changed' }), null);
  assert.equal(await handleMcpRequest({ method: 'tools/list' }), null);
  const unknown = await handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'nope' });
  assert.partialDeepStrictEqual(unknown, { id: 7, error: { code: -32601 } });
});

test('the stdio server reports malformed JSON and invalid requests, then keeps serving', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  runMcpServer(input, { write: (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; } });

  input.write('{not json\n');
  input.write('[]\n');
  input.write('null\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"ping"},5]\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  for (let waited = 0; lines.length < 5 && waited < 2000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const replies = lines.map((line): unknown => JSON.parse(line));
  const errorCodes = (value: unknown): number[] => {
    if (typeof value !== 'object' || value === null || !('error' in value)) return [];
    const { error } = value;
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? [error.code] : [];
  };

  // Replies may arrive in any order; match them by shape.
  const batch = replies.find((reply) => Array.isArray(reply));
  assert.partialDeepStrictEqual(batch, [{ id: 1, result: {} }, { id: null, error: { code: -32600 } }]);
  const singles = replies.filter((reply) => !Array.isArray(reply));
  assert.deepEqual(singles.flatMap(errorCodes).sort(), [-32700, -32600, -32600].sort());
  assert.ok(singles.some((reply) => JSON.stringify(reply) === JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })));
  assert.equal(replies.length, 5);
});
