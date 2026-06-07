import http from 'node:http';
import https from 'node:https';
import { readSession } from './session.mjs';

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function routeFor(command) {
  if (command.name === 'status' || command.name === 'context') return '/api/v1/session';
  return '/api/v1/notes';
}

export async function requestSession(session, pathname, init = {}) {
  const url = new URL(pathname, session.url);
  const transport = url.protocol === 'https:' ? https : http;
  const text = await new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: init.method || 'GET',
      rejectUnauthorized: false,
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          try { reject(new Error(JSON.parse(data).error)); } catch { reject(new Error(data || `HTTP ${res.statusCode}`)); }
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
  return JSON.parse(text);
}

export async function runAgentCommand(command, config) {
  const session = readSession(config.port);
  if (command.name === 'status' || command.name === 'context' || command.action === 'list') {
    output(await requestSession(session, routeFor(command)));
    return 0;
  }

  const op = command.action === 'add'
    ? {
        op: 'add',
        text: command.text,
        author: command.author || config.author,
        route: command.route || '/',
        side: command.side || null,
      }
    : command.action === 'resolve'
      ? { op: 'resolve', id: command.id }
      : command.action === 'reopen'
        ? { op: 'reopen', id: command.id }
        : command.action === 'remove'
          ? { op: 'remove', id: command.id }
          : { op: 'clear' };

  output(await requestSession(session, '/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(op),
  }));
  return 0;
}
