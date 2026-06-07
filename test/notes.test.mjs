import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNotes } from '../src/notes.mjs';

test('adds, resolves, reopens, and removes notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-notes-'));
  const notes = createNotes({ notesFile: path.join(dir, 'nested', 'notes.json'), author: 'test' });
  let list = notes.applyOp({ op: 'add', text: 'Check heading', route: '/about', side: 'dev' });
  assert.equal(list.length, 1);
  assert.equal(fs.statSync(path.join(dir, 'nested', 'notes.json')).mode & 0o777, 0o600);

  const id = list[0].id;
  list = notes.applyOp({ op: 'resolve', id });
  assert.equal(list[0].done, true);
  list = notes.applyOp({ op: 'reopen', id });
  assert.equal(list[0].done, false);
  list = notes.applyOp({ op: 'remove', id });
  assert.deepEqual(list, []);
});

test('rejects unknown operations and note ids', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-notes-')), 'notes.json');
  const notes = createNotes({ notesFile: file, author: 'test' });
  assert.throws(() => notes.applyOp({ op: 'wat' }), /Unknown notes operation/);
  assert.throws(() => notes.applyOp({ op: 'resolve', id: 'missing' }), /Unknown note id/);
});
