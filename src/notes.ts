import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { Note, Side } from './wire.ts';

export type { Note };

export type NoteOperation =
  | { op: 'add'; text: string; route?: string; side?: Side | null; author?: string }
  | { op: 'toggle' | 'resolve' | 'reopen' | 'remove'; id: string }
  | { op: 'clear' };

export interface NotesStore {
  load(): Note[];
  save(notes: Note[]): void;
  markdown(notes: Note[]): string;
  applyOp(op: unknown): Note[];
}

const MAX_NOTES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNote(value: unknown): Note | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['text'] !== 'string') return null;
  return {
    id: value['id'],
    text: value['text'],
    author: typeof value['author'] === 'string' ? value['author'] : '',
    route: typeof value['route'] === 'string' ? value['route'] : '/',
    side: value['side'] === 'dev' || value['side'] === 'live' ? value['side'] : null,
    done: value['done'] === true,
    ts: typeof value['ts'] === 'number' ? value['ts'] : 0,
  };
}

export function notesRevision(notes: readonly Note[]): string {
  return createHash('sha256').update(JSON.stringify(notes)).digest('hex').slice(0, 16);
}

// Review notes are a JSON file the server reads/mutates and the viewer polls,
// making it a shared channel between humans and AI sessions.
export function createNotes({ notesFile, author }: { notesFile: string; author?: string }): NotesStore {
  function load(): Note[] {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
      const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data['notes']) ? data['notes'] : [];
      return list.map(toNote).filter((note): note is Note => note !== null);
    } catch {
      return [];
    }
  }

  function save(notes: Note[]): void {
    fs.mkdirSync(path.dirname(notesFile), { recursive: true });
    const tmp = `${notesFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, notesFile);
  }

  function id(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function markdown(notes: Note[]): string {
    if (!notes.length) return '# sitedrift review notes\n\n_No notes yet._\n';
    const lines = ['# sitedrift review notes', ''];
    for (const note of notes) {
      const box = note.done ? '[x]' : '[ ]';
      const where = [note.route && note.route !== '/' ? note.route : '', note.side ? note.side.toUpperCase() : '']
        .filter(Boolean).join(' ');
      const tag = where ? ` _(${where})_` : '';
      lines.push(`- ${box} **${note.author || 'note'}:** ${note.text}${tag}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function applyOp(raw: unknown): Note[] {
    const op = isRecord(raw) ? raw : {};
    const name = typeof op['op'] === 'string' ? op['op'] : '';
    const noteId = typeof op['id'] === 'string' ? op['id'] : '';
    let notes = load();
    if (name === 'add') {
      if (!op['text']) throw new Error('A note needs text.');
      const text = String(op['text']).slice(0, 2000);
      const rawRoute = String(op['route'] || '/').slice(0, 2048);
      const route = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
      const who = String(op['author'] || author || 'note').slice(0, 24);
      const side = op['side'] === 'dev' || op['side'] === 'live' ? op['side'] : null;
      // Skip an identical open note so repeated `--note` seeding doesn't pile up.
      const duplicate = notes.some((note) => !note.done
        && note.text === text && note.route === route && note.author === who && note.side === side);
      if (!duplicate) {
        notes.push({ id: id(), text, author: who, route, side, done: false, ts: Date.now() });
        if (notes.length > MAX_NOTES) notes = notes.slice(-MAX_NOTES);
      }
    } else if (name === 'remove') {
      if (!notes.some((note) => note.id === noteId)) throw new Error(`Unknown note id: ${noteId}`);
      notes = notes.filter((note) => note.id !== noteId);
    } else if (name === 'toggle' || name === 'resolve' || name === 'reopen') {
      if (!notes.some((note) => note.id === noteId)) throw new Error(`Unknown note id: ${noteId}`);
      notes = notes.map((note) => {
        if (note.id !== noteId) return note;
        return { ...note, done: name === 'toggle' ? !note.done : name === 'resolve' };
      });
    } else if (name === 'clear') {
      notes = [];
    } else {
      throw new Error(`Unknown notes operation: ${name || '(missing)'}`);
    }
    save(notes);
    return notes;
  }

  return { load, save, markdown, applyOp };
}
