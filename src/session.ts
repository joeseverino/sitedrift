import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Side } from './frame-content.ts';

const SESSION_DIR = path.join(os.homedir(), '.sitedrift', 'sessions');

export interface Session {
  version: number;
  pid: number;
  url: string;
  frameUrls: Record<Side, string>;
  token: string;
  /** Base64 PEM of the local certificate, so control clients can pin it. */
  ca?: string;
  dev: string;
  live: string;
  notesFile: string;
  startedAt: string;
}

export interface SessionConfig {
  host: string;
  hostname?: string;
  port: number;
  devBase: URL;
  liveBase: URL;
  notesFile: string;
}

function sessionFile(port: number): string {
  return path.join(SESSION_DIR, `${port}.json`);
}

export function createSession(config: SessionConfig, scheme: 'http' | 'https', tls: { cert?: Buffer } | null = null): Session {
  const token = crypto.randomBytes(32).toString('base64url');
  const publicHost = config.hostname || config.host;
  const host = publicHost.includes(':') ? `[${publicHost}]` : publicHost;
  const url = `${scheme}://${host}:${config.port}`;
  const session: Session = {
    version: 1,
    pid: process.pid,
    url,
    frameUrls: {
      dev: `${scheme}://${host}:${config.port + 1}`,
      live: `${scheme}://${host}:${config.port + 2}`,
    },
    token,
    dev: config.devBase.href.replace(/\/$/, ''),
    live: config.liveBase.href.replace(/\/$/, ''),
    notesFile: config.notesFile,
    startedAt: new Date().toISOString(),
  };
  if (tls?.cert) session.ca = Buffer.from(tls.cert).toString('base64');
  return session;
}

export function writeSession(config: { port: number }, session: Session): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionFile(config.port), JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function removeSession(config: { port: number }): void {
  try {
    const file = sessionFile(config.port);
    const current: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isRecord(current) && current['pid'] === process.pid) {
      fs.unlinkSync(file);
    }
  } catch {
    // No session file, or one that is not ours: nothing to remove.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  const { frameUrls } = value;
  return typeof value['version'] === 'number'
    && typeof value['pid'] === 'number'
    && ['url', 'token', 'dev', 'live', 'notesFile', 'startedAt'].every((key) => typeof value[key] === 'string')
    && isRecord(frameUrls) && typeof frameUrls['dev'] === 'string' && typeof frameUrls['live'] === 'string'
    && (value['ca'] === undefined || typeof value['ca'] === 'string');
}

export function readSession(port: number): Session {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(sessionFile(port), 'utf8'));
    if (isSession(value)) return value;
  } catch {
    // Fall through to the shared error below.
  }
  throw new Error(`No running sitedrift session found on port ${port}.`);
}
