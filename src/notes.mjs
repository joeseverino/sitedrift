import fs from 'node:fs';

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
    try {
      const tmp = `${notesFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
      fs.renameSync(tmp, notesFile);
    } catch {}
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
      const route = op.route || '/';
      const who = (op.author || author || 'note').slice(0, 24);
      const side = op.side === 'dev' || op.side === 'live' ? op.side : null;
      // Skip an identical open note so repeated `--note` seeding doesn't pile up.
      const duplicate = notes.some((note) => !note.done
        && note.text === text && note.route === route && note.author === who && note.side === side);
      if (!duplicate) {
        notes.push({ id: id(), text, author: who, route, side, done: false, ts: Date.now() });
      }
    } else if (op.op === 'remove') {
      notes = notes.filter((note) => note.id !== op.id);
    } else if (op.op === 'toggle') {
      notes = notes.map((note) => (note.id === op.id ? { ...note, done: !note.done } : note));
    } else if (op.op === 'clear') {
      notes = [];
    }
    save(notes);
    return notes;
  }

  return { load, save, markdown, applyOp };
}
