import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('hosted frames allow same-origin styling and deployed interactions', () => {
  const source = fs.readFileSync(new URL('../assets/viewer.js', import.meta.url), 'utf8');
  const sandbox = source.match(/iframe\.setAttribute\('sandbox', '([^']+)'\)/)?.[1] || '';
  assert.match(sandbox, /\ballow-same-origin\b/);
  assert.match(sandbox, /\ballow-scripts\b/);
  assert.match(source, /function hostedSnapshot\(side\)/);
  assert.match(source, /renderMetadata\(side,/);
});
