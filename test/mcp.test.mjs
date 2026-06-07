import assert from 'node:assert/strict';
import test from 'node:test';

import { handleMcpRequest } from '../src/mcp.mjs';

test('MCP initializes and advertises the compact tool surface', async () => {
  const initialized = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal(initialized.result.serverInfo.name, 'sitedrift');

  const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('sitedrift_context'));
  assert.ok(names.includes('sitedrift_note_add'));
  assert.ok(names.includes('sitedrift_setup'));
});

test('MCP setup works before a sitedrift session exists', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'sitedrift_setup',
      arguments: { dev: 'http://localhost:3000', live: 'https://example.test' },
    },
  });
  assert.equal(response.result.structuredContent.config.dev, 'http://localhost:3000');
  assert.equal(response.result.structuredContent.mcp.command, 'sitedrift-mcp');
});

test('MCP exposes a short operational guide and review prompt', async () => {
  const resource = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'resources/read',
    params: { uri: 'sitedrift://guide' },
  });
  assert.match(resource.result.contents[0].text, /Call sitedrift_context before/);

  const prompt = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'prompts/get',
    params: { name: 'review_route', arguments: { route: '/pricing' } },
  });
  assert.match(prompt.result.messages[0].content.text, /\/pricing/);
});
