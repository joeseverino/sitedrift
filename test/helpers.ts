import http from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { TestContext } from 'node:test';

import type { AssetsBinding } from '../src/cloudflare-runtime.ts';
import type { ResponseLike } from '../src/http.ts';
import type { ProxyRequest } from '../src/proxy.ts';

export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('Server has no TCP address.'));
      else resolve(address.port);
    });
  });
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function httpRequest(
  port: number,
  pathname: string,
  { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A request with no body, for calling the proxy directly. */
export function fakeRequest(headers: IncomingHttpHeaders = {}, method = 'GET'): ProxyRequest {
  return {
    headers,
    method,
    async *[Symbol.asyncIterator]() {
      // no body
    },
  };
}

export interface Captured {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/** A response that records what was written, for calling the proxy directly. */
export function captureResponse(): { out: Captured; res: ResponseLike } {
  const out: Captured = { status: 0, headers: {}, body: '' };
  return {
    out,
    res: {
      writeHead(status, headers = {}) { out.status = status; out.headers = headers; },
      end(body) { out.body = body === undefined ? '' : String(body); },
    },
  };
}

export interface FetchCall {
  url: URL;
  init: RequestInit;
  headers: Headers;
}

/** Replaces global fetch until the test ends and records every call. */
export function mockFetch(t: TestContext, respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
    const call: FetchCall = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

/** The `text` of every note in a notes API response body. */
export function noteTexts(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('notes' in parsed) || !Array.isArray(parsed.notes)) {
    throw new Error(`Not a notes response: ${body}`);
  }
  const notes: unknown[] = parsed.notes;
  return notes.map((note) => {
    if (typeof note !== 'object' || note === null || !('text' in note) || typeof note.text !== 'string') {
      throw new Error(`Not a note: ${JSON.stringify(note)}`);
    }
    return note.text;
  });
}

export type AssetEntry = [body: string, type: string, status?: number, headers?: Record<string, string>];

/** In-memory ASSETS binding: path -> [body, content-type, status?, headers?]. Other paths 404. */
export function assetsFrom(files: Record<string, AssetEntry>): AssetsBinding {
  return {
    async fetch(input) {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const entry = files[pathname];
      if (!entry) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
      const [body, type, status = 200, headers = {}] = entry;
      return new Response(body, { status, headers: { 'content-type': type, ...headers } });
    },
  };
}

/** A preview build's assets: the config the install step writes, plus the given files. */
export function previewAssets(
  files: Record<string, AssetEntry> = {},
  config: Record<string, string> = { live: 'https://example.com' },
): AssetsBinding {
  return assetsFrom({
    '/__sitedrift/config.json': [JSON.stringify(config), 'application/json'],
    ...files,
  });
}
