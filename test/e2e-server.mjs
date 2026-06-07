import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('../', import.meta.url);
const notesFile = path.join(os.tmpdir(), `sitedrift-visual-${process.pid}.json`);

function page({
  label,
  accent,
  accentSoft,
  eyebrow,
  title,
  copy,
  primary,
  secondary,
  metric,
  delta,
  compactNav,
  release,
  releaseClass,
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${copy}">
  <meta property="og:title" content="${title}">
  <meta property="og:image" content="/fixture.png">
  <link rel="canonical" href="https://example.test/product">
  <title>${label} product analytics | Northstar</title>
  <style>
    *{box-sizing:border-box}html{background:#f7f8fc}body{margin:0;color:#141826;background:
      radial-gradient(circle at 80% 8%,${accentSoft},transparent 32%),#f7f8fc;
      font:15px/1.55 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    a{color:inherit;text-decoration:none}.shell{max-width:1180px;margin:auto;padding:0 28px}
    nav{height:68px;display:flex;align-items:center;gap:28px;border-bottom:1px solid #e4e7ef}
    .logo{display:flex;align-items:center;gap:9px;font-weight:850;letter-spacing:-.03em}.logo-mark{width:25px;height:25px;display:grid;
      place-items:center;color:white;background:${accent};border-radius:8px;box-shadow:0 8px 22px ${accentSoft};font-size:12px}
    .navlinks{display:flex;gap:22px;color:#697083;font-size:13px;font-weight:650}.navlinks a:first-child{color:#171b29}
    .nav-actions{margin-left:auto;display:flex;align-items:center;gap:9px}.nav-actions a{padding:8px 12px;border-radius:9px;font-size:12px;font-weight:750}
    .nav-actions .start{color:white;background:${accent};box-shadow:0 7px 18px ${accentSoft}}
    main{padding:64px 0 90px}.hero{display:grid;grid-template-columns:minmax(0,1.04fr) minmax(330px,.96fr);gap:42px;align-items:center}
    .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;color:${accent};background:white;border:1px solid #e4e7ef;
      border-radius:999px;box-shadow:0 5px 18px rgb(28 34 48 / 6%);font-size:10px;font-weight:850;letter-spacing:.1em;text-transform:uppercase}
    .eyebrow:before{content:"";width:6px;height:6px;border-radius:50%;background:${accent};box-shadow:0 0 0 4px ${accentSoft}}
    h1{max-width:620px;margin:20px 0 18px;font-size:clamp(42px,5.4vw,70px);line-height:.98;letter-spacing:-.062em}
    .lede{max-width:560px;margin:0;color:#626a7d;font-size:17px}.actions{display:flex;gap:10px;margin-top:28px}
    button{min-height:43px;padding:0 17px;border:1px solid #dfe3eb;border-radius:11px;background:white;color:#252a39;font:750 13px inherit;cursor:pointer}
    button.primary{color:white;background:${accent};border-color:${accent};box-shadow:0 10px 24px ${accentSoft}}
    .trust{display:flex;align-items:center;gap:10px;margin-top:25px;color:#747b8c;font-size:11px}.avatars{display:flex}
    .avatars span{width:23px;height:23px;display:grid;place-items:center;margin-left:-5px;border:2px solid #f7f8fc;border-radius:50%;
      color:white;background:#242938;font-size:8px;font-weight:800}.avatars span:first-child{margin-left:0}.avatars span:nth-child(2){background:${accent}}
    .product{position:relative;padding:12px;border:1px solid #dfe3eb;border-radius:22px;background:rgb(255 255 255 / 72%);
      box-shadow:0 26px 70px rgb(35 42 62 / 15%);backdrop-filter:blur(12px)}
    .window{overflow:hidden;border:1px solid #e3e6ed;border-radius:14px;background:white}.windowbar{height:38px;display:flex;align-items:center;gap:5px;padding:0 12px;
      border-bottom:1px solid #eceef3}.dot{width:6px;height:6px;border-radius:50%;background:#d6dae3}.windowbar b{margin-left:7px;font-size:9px;color:#858c9d}
    .dash{display:grid;grid-template-columns:88px 1fr;min-height:330px}.rail{padding:15px 10px;background:#111520;color:#727a8e}
    .rail strong{display:block;margin:0 4px 16px;color:#f2f4f8;font-size:9px}.rail i{display:block;height:8px;margin:12px 4px;border-radius:3px;background:#2a303e}
    .rail i.active{width:70%;background:${accent}}.content{padding:18px}.content-head{display:flex;justify-content:space-between;align-items:center}
    .content-head span{font-size:10px;color:#7a8294}.content-head b{font-size:12px}.period{padding:5px 7px;border:1px solid #e5e8ef;border-radius:6px;font-size:8px}
    .metric{margin-top:18px;padding:16px;border:1px solid #e7e9ef;border-radius:12px;background:#fcfcfe}.metric small{color:#798195;font-size:9px}
    .metric-value{display:flex;align-items:end;gap:8px;margin-top:4px}.metric-value strong{font-size:30px;line-height:1;letter-spacing:-.04em}
    .metric-value em{color:#139a63;background:#e5f8ef;border-radius:5px;padding:2px 5px;font-size:8px;font-style:normal;font-weight:800}
    .chart{height:105px;margin-top:18px;display:flex;align-items:end;gap:6px;border-bottom:1px solid #e7eaf0}
    .chart span{flex:1;min-width:4px;height:var(--h);border-radius:4px 4px 0 0;background:linear-gradient(${accent},${accentSoft})}
    .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.mini{padding:9px;border:1px solid #e8eaf0;border-radius:8px}
    .mini small{display:block;color:#8a91a1;font-size:7px}.mini b{font-size:11px}.release{position:absolute;right:-13px;bottom:25px;padding:9px 11px;
      color:white;background:#141925;border:1px solid #32394a;border-radius:10px;box-shadow:0 14px 35px rgb(17 21 31 / 28%);font-size:9px}
    .release b{display:block;color:${accent};font-size:8px;letter-spacing:.08em;text-transform:uppercase}
    .release.subtle{right:18px;bottom:18px;color:#5f6677;background:white;border-color:#e3e6ed;box-shadow:0 8px 22px rgb(35 42 62 / 10%)}
    .proof{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:78px}.proof article{padding:17px;border-top:1px solid #dfe3eb}
    .proof b{display:block;margin-bottom:4px;font-size:12px}.proof p{margin:0;color:#7a8293;font-size:10px}
    @media(max-width:760px){.shell{padding:0 20px}nav{height:58px}.navlinks{display:none}.nav-actions a:not(.start){display:none}
      main{padding:38px 0 60px}.hero{grid-template-columns:1fr;gap:36px}h1{font-size:48px}.lede{font-size:16px}.product{padding:9px}
      .dash{grid-template-columns:65px 1fr;min-height:300px}.rail{padding:14px 7px}.content{padding:14px}.release{right:-6px}
      .proof{grid-template-columns:1fr;margin-top:45px}.proof article{padding:13px 0}.navlinks.compact{display:${compactNav ? 'none' : 'flex'}}}
    @media(max-width:520px){.nav-actions{display:none}}
  </style>
</head>
<body>
  <div class="shell">
    <nav>
      <a class="logo" href="/"><span class="logo-mark">N</span>northstar</a>
      <div class="navlinks compact"><a href="/product">Product</a><a href="/customers">Customers</a><a href="/pricing">Pricing</a></div>
      <div class="nav-actions"><a href="/login">Sign in</a><a class="start" href="/signup">${primary}</a></div>
    </nav>
    <main>
      <section class="hero">
        <div>
          <span class="eyebrow">${eyebrow}</span>
          <h1>${title}</h1>
          <p class="lede">${copy}</p>
          <div class="actions"><button class="primary">${primary}</button><button>${secondary}</button></div>
          <div class="trust"><span class="avatars"><span>AK</span><span>LM</span><span>JR</span></span>Trusted by 2,400 product teams</div>
        </div>
        <div class="product">
          <div class="window">
            <div class="windowbar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><b>northstar / overview</b></div>
            <div class="dash">
              <aside class="rail"><strong>NORTHSTAR</strong><i class="active"></i><i></i><i></i><i></i><i></i></aside>
              <section class="content">
                <div class="content-head"><div><span>Workspace</span><br><b>Growth overview</b></div><span class="period">Last 30 days</span></div>
                <div class="metric"><small>ACTIVE USERS</small><div class="metric-value"><strong>${metric}</strong><em>${delta}</em></div>
                  <div class="chart">${[35,48,42,61,55,72,66,85,74,92,82,100].map((h) => `<span style="--h:${h}%"></span>`).join('')}</div>
                </div>
                <div class="cards"><div class="mini"><small>Activation</small><b>68.4%</b></div><div class="mini"><small>Retention</small><b>84.1%</b></div><div class="mini"><small>NPS</small><b>62</b></div></div>
              </section>
            </div>
          </div>
          <div class="release ${releaseClass || ''}"><b>${label}</b>${release}</div>
        </div>
      </section>
      <section class="proof"><article><b>One source of truth</b><p>Every signal connected to the same customer journey.</p></article>
        <article><b>Answers in seconds</b><p>Fast funnels, cohorts, and release comparisons.</p></article>
        <article><b>Built for teams</b><p>Share context without exporting another dashboard.</p></article></section>
    </main>
  </div>
</body>
</html>`;
}

function fixture(port, body) {
  const server = http.createServer((req, res) => {
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
    text: 'Primary CTA changed from demo to trial. Verify the experiment copy with product.',
    author: 'claude',
    route: '/product',
    side: 'dev',
    done: false,
    ts: 1760000000000,
  },
  {
    id: 'showcase-human',
    text: 'Dashboard metric is correct in DEV. Mobile layout verified at 412px.',
    author: 'joe',
    route: '/product',
    side: 'dev',
    done: true,
    ts: 1760000001000,
  },
], null, 2), { mode: 0o600 });

const dev = fixture(45101, page({
  label: 'Development',
  accent: '#6d5dfc',
  accentSoft: 'rgb(109 93 252 / 20%)',
  eyebrow: 'Product analytics',
  title: 'Turn product data into decisions.',
  copy: 'Bring every signal together and understand how customers move through your product.',
  primary: 'Start free',
  secondary: 'Explore product',
  metric: '48,291',
  delta: '+12.8%',
  compactNav: false,
  release: 'Candidate · v2.4',
  releaseClass: 'subtle',
}));
const live = fixture(45102, page({
  label: 'Production',
  accent: '#6357e8',
  accentSoft: 'rgb(99 87 232 / 18%)',
  eyebrow: 'Product analytics',
  title: 'Turn product data into decisions.',
  copy: 'Bring every signal together and understand how customers move through your product.',
  primary: 'Book a demo',
  secondary: 'Explore product',
  metric: '47,806',
  delta: '+11.2%',
  compactNav: false,
  release: 'Current · v2.3',
  releaseClass: 'subtle',
}));
const child = spawn(process.execPath, [
  new URL('../sitedrift.mjs', import.meta.url).pathname,
  '/product',
  '--port', '45110',
  '--dev', 'http://127.0.0.1:45101',
  '--live', 'http://127.0.0.1:45102',
  '--notes', notesFile,
  '--author', 'visual-test',
], { cwd: root, stdio: 'inherit' });

function stop() {
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
