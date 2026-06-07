import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('hosted frames allow same-origin styling and deployed interactions', () => {
  const source = fs.readFileSync(new URL('../assets/viewer.js', import.meta.url), 'utf8');
  const sandbox = source.match(/iframe\.setAttribute\('sandbox', '([^']+)'\)/)?.[1] || '';
  assert.match(sandbox, /\ballow-same-origin\b/);
  assert.match(sandbox, /\ballow-scripts\b/);
  assert.doesNotMatch(source, /function hostedSnapshot\(side\)/);
  assert.match(source, /message\.type === 'dismiss'/);
  assert.match(source, /data-compact-origin/);
  assert.match(source, /function showStatusPopover\(badge\)/);
  assert.match(source, /function metricDelta\(key\)/);
  assert.match(source, /hideStatusPopover\(\)/);
  assert.match(source, /site-compare-scroll', !!config\.hosted/);
  assert.match(source, /site-compare-mirror', !!config\.hosted/);
});
