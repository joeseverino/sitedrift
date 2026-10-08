import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNotes } from '../src/notes.ts';

function tempFile(...parts: string[]): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sitedrift-notes-')), ...parts);
}

test('adds, resolves, reopens, and removes notes', () => {
  const file = tempFile('nested', 'notes.json');
  const notes = createNotes({ notesFile: file, author: 'test' });
  let list = notes.applyOp({ op: 'add', text: 'Check heading', route: '/about', side: 'dev' });
  assert.equal(list.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const id = list[0]?.id;
  assert.ok(id);
  list = notes.applyOp({ op: 'resolve', id });
  assert.equal(list[0]?.done, true);
  list = notes.applyOp({ op: 'reopen', id });
  assert.equal(list[0]?.done, false);
  list = notes.applyOp({ op: 'toggle', id });
  assert.equal(list[0]?.done, true);
  list = notes.applyOp({ op: 'remove', id });
  assert.deepEqual(list, []);
});

test('rejects unknown operations and note ids', () => {
  const notes = createNotes({ notesFile: tempFile('notes.json'), author: 'test' });
  assert.throws(() => notes.applyOp({ op: 'wat' }), /Unknown notes operation/);
  assert.throws(() => notes.applyOp({ op: 'resolve', id: 'missing' }), /Unknown note id/);
  assert.throws(() => notes.applyOp({ op: 'add' }), /needs text/);
  assert.throws(() => notes.applyOp(null), /Unknown notes operation: \(missing\)/);
});

test('an identical open note is not added twice', () => {
  const notes = createNotes({ notesFile: tempFile('notes.json'), author: 'test' });
  notes.applyOp({ op: 'add', text: 'Same', route: '/a' });
  assert.equal(notes.applyOp({ op: 'add', text: 'Same', route: '/a' }).length, 1);
});

test('entries that are not notes are ignored instead of breaking the list', () => {
  const file = tempFile('notes.json');
  fs.writeFileSync(file, JSON.stringify({
    notes: [
      { id: 'a', text: 'Real', side: 'live', done: true },
      { id: 'b' },
      'junk',
      null,
      { id: 'c', text: 'Odd side', side: { toUpperCase: 1 } },
    ],
  }));
  const notes = createNotes({ notesFile: file, author: 'test' });
  const list = notes.load();
  assert.deepEqual(list.map((note) => note.id), ['a', 'c']);
  assert.equal(list[1]?.side, null);
  assert.match(notes.markdown(list), /\[x\] \*\*note:\*\* Real _\(LIVE\)_/);
});
