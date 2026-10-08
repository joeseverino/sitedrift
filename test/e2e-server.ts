import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const notesFile = path.join(os.tmpdir(), `sitedrift-visual-${process.pid}.json`);

interface PageOptions {
  title: string;
  heading: string;
  description: string;
  reserve: string;
  hours: string;
  dishes: ReadonlyArray<readonly [name: string, detail: string, price: string]>;
}

function page({ title, heading, description, reserve, hours, dishes }: PageOptions): string {
  const rows = dishes
    .map(([name, detail, price]) => `<li><div><h3>${name}</h3><p>${detail}</p></div><span>${price}</span></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:image" content="/fixture.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="canonical" href="https://example.test/menu">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;color:#262320;background:#faf8f4;font:16px/1.6 Georgia,"Times New Roman",serif}
    a{color:inherit}.wrap{max-width:760px;margin:auto;padding:0 28px}
    header{border-bottom:1px solid #ddd6ca}
    nav{display:flex;align-items:baseline;gap:28px;padding:22px 0;font:14px system-ui,sans-serif}
    .name{margin-right:auto;font:700 20px Georgia,serif;text-decoration:none}
    nav a:not(.name){color:#6b645a;text-decoration:none}nav a.current{color:#262320;border-bottom:1px solid #262320}
    main.wrap{padding-block:56px 72px}
    h1{margin:0 0 12px;font-size:44px;line-height:1.1;font-weight:400}
    .intro{max-width:34em;margin:0 0 28px;color:#6b645a;font-size:18px}
    .visit{display:flex;flex-wrap:wrap;align-items:center;gap:18px;margin:0 0 48px;font:14px system-ui,sans-serif;color:#6b645a}
    .visit a{padding:9px 16px;color:#faf8f4;background:#262320;text-decoration:none;border-radius:2px}
    h2{margin:40px 0 4px;padding-bottom:8px;border-bottom:1px solid #ddd6ca;font:600 12px system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#6b645a}
    ul{margin:0;padding:0;list-style:none}
    li{display:flex;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:1px solid #ece6db}
    li h3{margin:0;font-size:18px;font-weight:600}li p{margin:2px 0 0;color:#6b645a;font-size:15px}li span{font-variant-numeric:tabular-nums}
    footer{padding:28px 0 40px;border-top:1px solid #ddd6ca;color:#6b645a;font:13px system-ui,sans-serif}
    @media(max-width:600px){.wrap{padding:0 20px}nav{gap:16px;padding:16px 0}main.wrap{padding-block:32px 48px}h1{font-size:34px}.intro{font-size:16px}}
  </style>
</head>
<body>
  <header><div class="wrap"><nav><a class="name" href="/">Fennel &amp; Salt</a><a class="current" href="/menu">Menu</a><a href="/visit">Visit</a><a href="/contact">Contact</a></nav></div></header>
  <main class="wrap">
    <h1>${heading}</h1>
    <p class="intro">${description}</p>
    <p class="visit"><span>${hours}</span><a href="/reserve">${reserve}</a></p>
    <h2>Dinner</h2>
    <ul>${rows}</ul>
    <h2>Dessert</h2>
    <ul><li><div><h3>Honey cake</h3><p>Whipped ricotta, thyme</p></div><span>11</span></li><li><div><h3>Dark chocolate pot</h3><p>Olive oil, sea salt</p></div><span>10</span></li></ul>
  </main>
  <footer><div class="wrap">14 Mill Street, Portland &middot; Closed Mondays</div></footer>
</body>
</html>`;
}

function fixture(port: number, body: string): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#262320"/><path d="M11 8h11v3h-7.5v4H21v3h-6.5v6H11z" fill="#faf8f4"/></svg>');
      return;
    }
    if (req.url === '/favicon.ico' || req.url === '/fixture.png') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

fs.writeFileSync(notesFile, JSON.stringify([
  {
    id: 'showcase-agent',
    text: 'Hours say Tuesday to Sunday on DEV, Wednesday to Sunday on LIVE. Confirm the new opening day before launch.',
    author: 'agent',
    route: '/menu',
    side: 'dev',
    done: false,
    ts: 1760000000000,
  },
  {
    id: 'showcase-human',
    text: 'Lamb shoulder is 28 on DEV and 26 on LIVE. The new price is correct. Mobile layout checked at 412px.',
    author: 'sam',
    route: '/menu',
    side: 'dev',
    done: true,
    ts: 1760000001000,
  },
], null, 2), { mode: 0o600 });

// Ports default to the committed range but are env-overridable so the suite can
// run alongside a live sitedrift preview without colliding on these ports.
const PORT = Number(process.env['SD_E2E_PORT'] || 45110);
const DEV_PORT = Number(process.env['SD_E2E_DEV_PORT'] || 45101);
const LIVE_PORT = Number(process.env['SD_E2E_LIVE_PORT'] || 45102);

const dev = fixture(DEV_PORT, page({
  title: 'Spring dinner menu | Fennel & Salt, Portland',
  heading: 'Dinner menu',
  description: 'Seasonal plates cooked over wood, with a short list of natural wines and cider.',
  reserve: 'Reserve a table',
  hours: 'Tuesday to Sunday, 5 to 10 pm',
  dishes: [
    ['Asparagus', 'Brown butter, soft egg yolk, chives', '16'],
    ['Wood-fired flatbread', 'Whipped feta, spring onion, lemon', '13'],
    ['Braised lamb shoulder', 'White beans, salsa verde', '28'],
    ['Roast cod', 'Peas, mint, charred lettuce', '27'],
  ],
}));
const live = fixture(LIVE_PORT, page({
  title: 'Dinner menu | Fennel & Salt, Portland',
  heading: 'Dinner menu',
  description: 'Seasonal plates cooked over wood, with a short list of natural wines and cider.',
  reserve: 'Book a table',
  hours: 'Wednesday to Sunday, 5 to 10 pm',
  dishes: [
    ['Roasted squash soup', 'Sage, toasted pumpkin seeds', '12'],
    ['Wood-fired flatbread', 'Whipped feta, spring onion, lemon', '13'],
    ['Braised lamb shoulder', 'White beans, salsa verde', '26'],
    ['Roast cod', 'Peas, mint, charred lettuce', '27'],
  ],
}));
const child = spawn(process.execPath, [
  path.join(root, process.env['SD_E2E_BUILT'] === '1' ? 'dist/sitedrift.js' : 'src/sitedrift.ts'),
  '/menu',
  '--port', String(PORT),
  '--dev', `http://127.0.0.1:${DEV_PORT}`,
  '--live', `http://127.0.0.1:${LIVE_PORT}`,
  '--notes', notesFile,
  '--author', 'visual-test',
], { cwd: root, stdio: 'inherit' });

function stop(): void {
  child.kill('SIGTERM');
  dev.close();
  live.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stop();
    process.exit(0);
  });
}
child.once('exit', (code) => {
  dev.close();
  live.close();
  process.exit(code ?? 0);
});
