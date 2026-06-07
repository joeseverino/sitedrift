# sitedrift

**Catch the drift between dev and live.** A zero-build, zero-dependency dev tool
that frames your local site and production **side-by-side on the same route**,
locked to the same scroll — then overlays them in `difference` mode so the only
things that light up are the pixels that actually changed.

```
┌─────────────── sitedrift ───────────────┐
│  DEV  ▸ /pricing      200   LIVE ▸ /pricing 200 │
│ ┌───────────┐ │ ┌───────────┐  Overlay ▸ Diff   │
│ │  $19      │ │ │  $29      │  ≠ meta           │
│ │ [Start…]  │ │ │ [Get…]    │  ✓ author notes   │
│ └───────────┘ │ └───────────┘                   │
└──────────────────────────────────────────┘
```

---

## Quick start

No install — run it with `npx` (needs Node ≥ 18):

```bash
npx sitedrift /pricing \
  --dev http://localhost:4321 \
  --live https://example.com \
  --open
```

That boots the viewer on `http://127.0.0.1:4178`, opens it at `/pricing`, and
puts your dev build on the left and production on the right. Type any route in
the toolbar and both panes follow.

Install it globally if you reach for it often:

```bash
npm i -g sitedrift
sitedrift /pricing -d http://localhost:4321 -l https://example.com -o
```

---

## What it does

- **One view switch** — Split (divider) · Solo (one pane, Swap flips) · Overlay
  (stacked). In Overlay an opacity slider blends the panes and **Diff**
  (`mix-blend-mode: difference`) lights up only the changed pixels. Overlay
  force-locks scrolling so the panes can't drift. Keys: `O` overlay, `D` diff.
- **Locked scrolling** with one controller (exact pixel or proportional) — no
  duplicate scrollbars, no bounce. An internal link click mirrors to both panes.
- **Metadata diff + status** — title / description / canonical compared across
  sides (`≠ meta`), and a per-pane `200/3xx/4xx/5xx/ERR` badge refreshed on every
  route load, so a route that 404s on one side jumps out.
- **SEO panel** — Google-style snippet preview + a ~13-point checklist per pane
  (title/description length, single H1, canonical, viewport, lang, Open Graph,
  noindex, image alt…), with a flag showing how many checks fail.
- **Review notes as a shared channel** — author/route/side-tagged notes in a JSON
  file the viewer polls every 4s, so a teammate or an AI coding session can leave
  notes that appear live. Click a note to jump to its route, copy a per-note
  deep link, dock or float the drawer, and **Send to vault** or export Markdown.
- **No dependencies.** Node standard library only.

### Keyboard

| Key | Action |
|---|---|
| `O` | Toggle Overlay |
| `D` | Toggle the Overlay difference blend |
| `S` | Swap sides |
| `R` | Reload both panes |
| `0` | Reset divider to 50/50 |
| `/` | Focus the route field |
| `Space` / `⇧Space` | Page down / up (when scrolling is linked) |
| `↑` `↓` | Line scroll both panes |
| `Esc` | Close the notes drawer / open popovers |

Shortcuts work whether focus is in the viewer chrome or inside either pane.

---

## Options

Every option is a CLI flag, and also reads a `SITEDRIFT_<NAME>` env var.
Precedence is **flag > env > default**.

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `-d, --dev <url>` | `SITEDRIFT_DEV` | `http://127.0.0.1:4321` | Left-pane (dev) origin. |
| `-l, --live <url>` | `SITEDRIFT_LIVE` | `https://example.com` | Right-pane (live) origin. |
| `-p, --port <n>` | `SITEDRIFT_PORT` | `4178` | Listen port. |
| `--host <addr>` | `SITEDRIFT_HOST` | `127.0.0.1` | Bind address. |
| `-o, --open` | — | off | Open the viewer in your browser. |
| `--http` | — | — | Force plain HTTP (ignore `--cert`/`--key`). |
| `--cert <file>` / `--key <file>` | `SITEDRIFT_CERT` / `_KEY` | — | If both set, serve over HTTPS. |
| `--notes <file>` | `SITEDRIFT_NOTES` | `$TMPDIR/sitedrift-notes.json` | Shared review-notes file. |
| `--brand <text>` | `SITEDRIFT_BRAND` | — | Strip `\| <text>` from titles in pane headers. |
| `--author <name>` | `SITEDRIFT_AUTHOR` | `you` | Byline for notes added in the viewer. |
| `--vault <dir>` | `SITEDRIFT_VAULT` | — | Enable **Send to vault** (writes the review markdown here). |

A positional `[path]` (e.g. `sitedrift /pricing`) sets the initial route.
`-h, --help` and `-v, --version` do what you'd expect.

### HTTP endpoints

| Route | Purpose |
|---|---|
| `GET /` | The viewer. |
| `GET /health` | `{ dev, live, version }`. |
| `GET /notes` · `POST /notes` | Read / mutate notes (`op: add\|remove\|toggle\|clear`). |
| `GET /notes.md` | Notes as a Markdown checklist. |
| `POST /notes/save` | Write the notes markdown into `--vault`. |
| `GET /icon.svg` | The app mark / favicon. |
| `GET /__dev/*` · `GET /__live/*` | Proxied origins. |

`POST /notes` requires `Content-Type: application/json`, so a cross-origin page
can't forge a no-preflight write. Add a note from anywhere:

```bash
curl -X POST localhost:4178/notes -H 'content-type: application/json' \
  -d '{"op":"add","text":"H1 on /about is larger on LIVE",
       "author":"claude","route":"/about","side":"live"}'
```

Most viewer state (route, layout, scroll mode, focus) is mirrored into the URL
query string, so a link reproduces the exact view.

---

## Security — local development only

The proxy strips `Content-Security-Policy`, `X-Frame-Options`, and the
Cross-Origin-{Embedder,Opener,Resource}-Policy headers so production can be
framed next to dev. That is safe **only on loopback**:

- It binds to `127.0.0.1` unless you override `--host`. **Do not** bind it to a
  public interface or put it behind a public proxy.
- Treat the notes file as plaintext shared scratch space.

## Limitations

- **URL rewriting is regex-based**, tuned for static sites (e.g. Astro builds).
  It rewrites root-relative `href`/`src`/`srcset`/`url(...)` and Vite/`_astro`
  paths, but won't catch URLs built in JS (`fetch`, dynamic `import`, import
  maps). SPAs with client-side absolute fetches may need extra rules.
- Designed for two origins of the *same* site, not arbitrary cross-site diffing.

---

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals, invariants, and the
  module map.

## Credits

Created by [Joe Severino](https://github.com/joeseverino).

## License

[MIT](LICENSE) © 2026 Joe Severino
