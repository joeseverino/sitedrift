// Project configuration shared by the local viewer and the Cloudflare command:
// sitedrift.config.json, .sitedriftrc.json, or a "sitedrift" key in package.json,
// discovered from the working directory upward.

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_NAMES = ['sitedrift.config.json', '.sitedriftrc.json'];

const CONFIG_KEYS: readonly string[] = Object.freeze([
  // Local viewer
  'dev', 'live', 'port', 'host', 'hostname', 'cert', 'key', 'notes', 'brand', 'author', 'vault', 'https', 'open',
  // Hosted previews
  'dir', 'productionBranch', 'nonce',
]);

interface FoundConfig {
  file: string;
  key?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findConfig(start: string): FoundConfig | null {
  let dir = path.resolve(start);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file };
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (isRecord(value) && 'sitedrift' in value) return { file: pkg, key: 'sitedrift' };
      } catch {
        // An unreadable package.json is not sitedrift's to report.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Reads sitedrift.config.json, .sitedriftrc.json, or package.json "sitedrift". Unknown keys are an error so typos surface. */
export function readProjectConfig({ explicit, cwd = process.cwd() }: { explicit?: string; cwd?: string } = {}): Record<string, unknown> {
  const found: FoundConfig | null = explicit ? { file: path.resolve(cwd, explicit) } : findConfig(cwd);
  if (!found) return {};
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(found.file, 'utf8'));
    if (found.key !== undefined && isRecord(value)) value = value[found.key];
  } catch (error) {
    throw new Error(`Could not read config ${found.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const where = found.key !== undefined ? `${found.file} ("${found.key}")` : found.file;
  if (!isRecord(value)) throw new Error(`Config ${where} must contain a JSON object.`);
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown config key${unknown.length === 1 ? '' : 's'} in ${where}: ${unknown.join(', ')}`);
  return value;
}
