import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_DIR = path.join(os.homedir(), '.sitedrift', 'sessions');

export function sessionFile(port) {
  return path.join(SESSION_DIR, `${port}.json`);
}

export function createSession(config, scheme) {
  const token = crypto.randomBytes(32).toString('base64url');
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `${scheme}://${host}:${config.port}`;
  const frameUrls = {
    dev: `${scheme}://${host}:${config.port + 1}`,
    live: `${scheme}://${host}:${config.port + 2}`,
  };
  const session = {
    version: 1,
    pid: process.pid,
    url,
    frameUrls,
    token,
    dev: config.devBase.href.replace(/\/$/, ''),
    live: config.liveBase.href.replace(/\/$/, ''),
    notesFile: config.notesFile,
    startedAt: new Date().toISOString(),
  };
  return session;
}

export function writeSession(config, session) {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionFile(config.port), JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function removeSession(config) {
  try {
    const file = sessionFile(config.port);
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.pid === process.pid) fs.unlinkSync(file);
  } catch {}
}

export function readSession(port) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(port), 'utf8'));
  } catch {
    throw new Error(`No running sitedrift session found on port ${port}.`);
  }
}
