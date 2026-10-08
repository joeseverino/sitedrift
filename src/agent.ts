import http from 'node:http';
import https from 'node:https';

import type { AgentCommand } from './cli.ts';
import type { NoteOperation } from './notes.ts';
import { readSession } from './session.ts';
import type { Session } from './session.ts';

export interface SessionRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(data: string, status: number | undefined): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON: report the body as is.
  }
  return data || `HTTP ${status ?? 500}`;
}

/** Calls the control API of a running session and returns the parsed JSON body. */
export async function requestSession(session: Session, pathname: string, init: SessionRequest = {}): Promise<unknown> {
  const url = new URL(pathname, session.url);
  const transport = url.protocol === 'https:' ? https : http;
  const text = await new Promise<string>((resolve, reject) => {
    const req = transport.request(url, {
      method: init.method || 'GET',
      ...(session.ca ? { ca: Buffer.from(session.ca, 'base64') } : {}),
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) reject(new Error(errorMessage(data, res.statusCode)));
        else resolve(data);
      });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ECONNREFUSED'
        ? new Error(`The sitedrift session at ${session.url} is not responding. Restart sitedrift.`)
        : error);
    });
    if (init.body) req.write(init.body);
    req.end();
  });
  return JSON.parse(text);
}

function noteOperation(command: AgentCommand, defaultAuthor: string): NoteOperation | null {
  if (command.name !== 'notes') return null;
  switch (command.action) {
    case 'add':
      return {
        op: 'add',
        text: command.text,
        author: command.author || defaultAuthor,
        route: command.route || '/',
        side: command.side ?? null,
      };
    case 'resolve':
    case 'reopen':
    case 'remove':
      return { op: command.action, id: command.id };
    case 'clear':
      return { op: 'clear' };
    case 'list':
      return null;
  }
}

export async function runAgentCommand(command: AgentCommand, config: { port: number; author: string }): Promise<number> {
  const session = readSession(config.port);
  const op = noteOperation(command, config.author);
  if (!op) {
    output(await requestSession(session, command.name === 'notes' ? '/api/v1/notes' : '/api/v1/session'));
    return 0;
  }
  output(await requestSession(session, '/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(op),
  }));
  return 0;
}
