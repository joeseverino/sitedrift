import fs from 'node:fs';
import path from 'node:path';

// Review notes are a JSON file the server reads/mutates and the viewer polls,
// making it a shared channel between humans and AI sessions.
export function createNotes({ notesFile, author }) {
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
      if (Array.isArray(data)) return data;
      return Array.isArray(data.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }

  function save(notes) {
    fs.mkdirSync(path.dirname(notesFile), { recursive: true });
    const tmp = `${notesFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, notesFile);
  }

  function id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function markdown(notes) {
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

  function applyOp(op) {
    let notes = load();
    if (op.op === 'add' && op.text) {
      const text = String(op.text).slice(0, 2000);
      const rawRoute = String(op.route || '/').slice(0, 2048);
      const route = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
      const who = String(op.author || author || 'note').slice(0, 24);
      const side = op.side === 'dev' || op.side === 'live' ? op.side : null;
      // Skip an identical open note so repeated `--note` seeding doesn't pile up.
      const duplicate = notes.some((note) => !note.done
        && note.text === text && note.route === route && note.author === who && note.side === side);
      if (!duplicate) {
        notes.push({ id: id(), text, author: who, route, side, done: false, ts: Date.now() });
        if (notes.length > 1000) notes = notes.slice(-1000);
      }
    } else if (op.op === 'remove') {
      if (!notes.some((note) => note.id === op.id)) throw new Error(`Unknown note id: ${op.id}`);
      notes = notes.filter((note) => note.id !== op.id);
    } else if (op.op === 'toggle' || op.op === 'resolve' || op.op === 'reopen') {
      const found = notes.some((note) => note.id === op.id);
      if (!found) throw new Error(`Unknown note id: ${op.id}`);
      notes = notes.map((note) => {
        if (note.id !== op.id) return note;
        const done = op.op === 'toggle' ? !note.done : op.op === 'resolve';
        return { ...note, done };
      });
    } else if (op.op === 'clear') {
      notes = [];
    } else {
      throw new Error(`Unknown notes operation: ${op.op || '(missing)'}`);
    }
    save(notes);
    return notes;
  }

  return { load, save, markdown, applyOp };
}
