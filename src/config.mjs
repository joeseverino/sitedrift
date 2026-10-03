// Project configuration shared by the local viewer and the Cloudflare command:
// sitedrift.config.json, .sitedriftrc.json, or a "sitedrift" key in package.json,
// discovered from the working directory upward.

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_NAMES = ['sitedrift.config.json', '.sitedriftrc.json'];

export const CONFIG_KEYS = Object.freeze([
  // Local viewer
  'dev', 'live', 'port', 'host', 'hostname', 'cert', 'key', 'notes', 'brand', 'author', 'vault', 'https', 'open',
  // Hosted previews
  'dir', 'productionBranch', 'nonce',
]);

/**
 * @param {string} start
 * @returns {{ file: string, key?: string } | null}
 */
function findConfig(start) {
  let dir = path.resolve(start);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file };
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const value = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (value && typeof value === 'object' && 'sitedrift' in value) return { file: pkg, key: 'sitedrift' };
      } catch {
        // An unreadable package.json is not sitedrift's to report.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Reads the project configuration. Unknown keys are an error so typos surface.
 * @param {{ explicit?: string, cwd?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function readProjectConfig({ explicit, cwd = process.cwd() } = {}) {
  const found = explicit ? { file: path.resolve(cwd, explicit) } : findConfig(cwd);
  if (!found) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    if (found.key) value = value[found.key];
  } catch (error) {
    throw new Error(`Could not read config ${found.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const where = found.key ? `${found.file} ("${found.key}")` : found.file;
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Config ${where} must contain a JSON object.`);
  }
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown config key${unknown.length === 1 ? '' : 's'} in ${where}: ${unknown.join(', ')}`);
  return value;
}
