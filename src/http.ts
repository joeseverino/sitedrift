import type { IncomingMessage } from 'node:http';

/** The part of an `http.ServerResponse` the helpers use, so tests can pass a plain object. */
export interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  end(body?: string | Buffer): unknown;
}

export class HttpError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function send(res: ResponseLike, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Reads a request body as UTF-8 text, rejecting with a 413 once it exceeds `limit` bytes. */
export function readBody(req: IncomingMessage, limit = 1e6): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError('request body too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
