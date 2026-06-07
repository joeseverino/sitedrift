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

## Status — placeholder

> This repo is a **placeholder / future home**. The tool is real and in daily
> use, but its canonical source currently lives inside Joe's personal toolchain:
>
> - implementation: `tools/lib/site-compare.mjs` (single file, stdlib only)
> - launcher: `site compare` (TLS via the homelab cert, process lifecycle)
> - app mark: `tools/lib/site-compare-icon.svg`
>
> It is intentionally **not extracted yet**. When it is, this repo becomes the
> `sitedrift` npm package. The migration plan already exists — see
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §10 ("Extraction map"), which
> lays out the module boundaries (`proxy`, `notes`, `scroll`, `viewer`, …) and a
> lowest-risk extraction order. (The in-tool product is currently branded
> "Site Compare"; it gets renamed to **sitedrift** on extraction.)

---

## What it does

- **One view switch** — Split (divider) · Solo (one pane, Swap flips) · Overlay
  (stacked). In Overlay an opacity slider blends the panes and **Diff**
  (`mix-blend-mode: difference`) lights up only the changed pixels. Overlay
  force-locks scrolling so the panes can't drift. Keys: `O` overlay, `D` diff.
- **Locked scrolling** with one controller (exact pixel or proportional).
- **Metadata diff + status** — title / description / canonical compared across
  sides (`≠ meta`), and per-pane `200/3xx/4xx/5xx` badges.
- **SEO panel** — Google-style snippet preview + a ~13-point checklist per pane,
  with a flag showing how many checks fail.
- **Review notes as a shared channel** — author/route/side-tagged notes in a JSON
  file the viewer polls, so a teammate or an AI session leaves notes that appear
  live. Click a note to jump to its route, copy a per-note link, dock or float
  the drawer, and **Send to vault** or export Markdown.
- **No dependencies.** Node stdlib only — the thing that makes extraction cheap.

## Planned (on extraction)

- `npx sitedrift` standalone bin.
- `sitedrift.config.json` as an alternative to env vars.
- Pixel-diff capture/export (the live `difference` overlay already ships).

---

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals, invariants, the
  audit log, and the extraction map.

## Credits

Created by [Joe Severino](https://github.com/joeseverino) ·
github.com/joeseverino

## License

TBD on extraction.
