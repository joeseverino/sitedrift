# sitedrift — Architecture

Technical companion to the [README](./sitedrift.README.md). This documents
the internals of `sitedrift.mjs`, the non-obvious decisions, the invariants
that must hold, and a concrete **extraction map** for splitting the single file
into an npm package.

Audience: anyone modifying the proxy, the scroll controller, or the notes
channel. Read the relevant invariants before you "simplify" anything here —
several parts look redundant but are load-bearing.

---

## 1. Shape and constraints

- **One file, zero runtime dependencies.** Only Node stdlib (`http`, `https`,
  `fs`, `os`, `url`, global `fetch`). This is a hard design constraint: it keeps
  the tool copy-pasteable and trivial to vendor. Do not add dependencies without
  a deliberate decision to give that up.
- **The viewer is server-rendered as a single HTML string** (`viewerHtml()`),
  CSS and client JS inlined. There is no build step and no client framework.
- **It is a development tool**, not a server. It mutates global response headers
  (§7) and binds to loopback by default. Never expose it publicly.

Two artifacts ship alongside the module:

- `sitedrift-icon.svg` — read at startup, served at `/icon.svg`, used as the
  favicon and toolbar mark.
- The `site` CLI wrapper — process lifecycle, TLS cert wiring, and the
  version/health handshake (§9). The CLI is *not* part of the package surface;
  the module is self-launching via env vars.

---

## 2. Process model & request lifecycle

A single `http`/`https` server with one `handler`. TLS is opt-in:

```
certFile && keyFile  →  https.createServer({cert, key})
otherwise            →  http.createServer()
```

`handler(req, res)` is a flat routing table, matched in order:

| Match | Handler |
|---|---|
| `/health` | JSON `{ dev, live, version }` — the handshake source (§9). |
| `/notes` | `GET` returns the list; `POST` (JSON only) applies one op (§8). |
| `/notes.md` | Markdown render of the list. |
| `/notes/save` | `POST` writes the markdown into `SITE_COMPARE_VAULT` (§8.4). |
| `/icon.svg` | The startup-loaded SVG, cached 1 day. |
| `/__dev/*` | `proxy(req, res, 'dev', url)` (§3). |
| `/__live/*` | `proxy(req, res, 'live', url)` (§3). |
| _fallback_ | **Referer-based asset rescue**, else the viewer (§3.3). |

There is no router abstraction by design — the table is short and the ordering
is the contract.

---

## 3. Reverse proxy & URL rewriting

The hardest-to-reason-about subsystem. Goal: render two *different* origins
inside one same-origin document so they can be framed without tripping
cross-origin isolation, and so root-relative links keep working.

### 3.1 Origin mapping

Each side is exposed under a path prefix:

- `devBase` (default `http://127.0.0.1:4321`) → `/__dev/*`
- `liveBase` (default `https://example.com`) → `/__live/*`

`targetFor(side, pathname, search)` strips the `/__<side>` prefix and rebuilds
the absolute upstream URL. `cleanBase()` normalizes the configured origins
(trailing slash, no query/hash) once at startup.

### 3.2 `rewriteRootPaths(body, side)` — the rewrite rules

Applied only to `text/html | text/css | javascript | application/json`
responses. It prefixes root-relative references so the browser requests them
back through the correct side's proxy prefix:

- `href|src|action|poster="/…"` → `"/__<side>/…"`
- `srcset="… /…, /…"` → each candidate prefixed
- `url(/…)` in CSS → `url(/__<side>/…)`
- Vite/Astro internals: `"/@id/"`, `"/@vite/"`, `"/@fs/"`, `"/_astro/"`

**The blind spot, stated plainly:** anything a *script* constructs at runtime —
`fetch('/api/…')`, dynamic `import('/…')`, import maps, `new URL('/…', …)` — is
**not** rewritten, because it isn't in the static HTML/CSS/JS text. This is why
the README scopes the tool to "static sites (Astro builds)." A future SPA
dependency on the live site is the most likely thing to break here. If that
happens, the fix is either a Service Worker shim injected into each frame, or a
runtime `fetch`/`XHR` patch injected at the top of `<head>` — *not* more regex.

### 3.3 Referer-based asset rescue (the non-obvious part)

A framed document may still emit a request with **no** `/__<side>` prefix —
e.g. a stylesheet referencing a font by an absolute path that escaped the
rewrite, or a script that hits a root path. Those land in the fallback branch.
Rather than 404, the handler inspects `req.headers.referer`: if it contains
`/__dev/` or `/__live/`, the request is re-prefixed to that side and proxied.
Only with no usable referer does the fallback serve the viewer page.

> **Invariant:** the viewer page must be the *last* resort in the fallback, and
> the referer check must come first. Reversing this serves HTML where an asset
> was expected and silently corrupts the framed render. This branch has no
> tests; treat it carefully.

### 3.4 Response handling

`proxy()`:
- Forwards the request, **deletes `accept-encoding`** (so upstream returns
  uncompressed text the rewriter can edit) and `connection`.
- Strips a fixed set of headers (§7) from the response.
- Rewrites `Location` on same-origin redirects back into the `/__<side>` space
  so redirects stay inside the comparison.
- Forces `Cache-Control: no-store` — comparisons must always be fresh.

---

## 4. The viewer

`viewerHtml()` returns the entire page as a template literal. Two things to know
before editing it:

- **Config injection.** Server state crosses into the client as a single JSON
  blob: `const config = ${config}` where `config` is
  `{ dev, live, brand, author }`, JSON-stringified with `<` escaped to
  `<` to prevent `</script>` breakout. Anything the client needs from the
  server goes through this object — keep it small.
- **Template-literal hazards.** The client JS lives inside a backtick string, so
  every client-side `\` is `\\`, and a literal `${` in client code is a *server*
  interpolation. (This already bit the brand-escape regex once — see the
  `brandStrip` source, which is written to avoid `${` adjacency.) When adding
  client regexes or `${...}`, mentally render the server pass first.

The viewer is server-rendered but otherwise a normal DOM app. Validate changes
with `node --check` **and** by extracting the inline `<script>` and
`node --check`-ing that separately (the template-literal layer hides syntax
errors from the module-level check).

---

## 5. Locked scroll controller

The most subtle subsystem; the part most likely to regress. Goal: scrolling
either pane moves both, with exactly one authority at a time and no feedback
loops between the two `scroll` event streams.

### 5.1 Concepts

- **`scrollOwner`** — the side currently driving. Set on any
  `wheel/touchstart/pointerdown/keydown` in a frame (capture listeners). Only
  the owner's `scroll` events propagate to the other side; this is what breaks
  the A-scrolls-B-scrolls-A loop.
- **`suppressScrollUntil[side]`** — a short timestamp gate. When we *programmatically*
  set a pane's `scrollTop`, we set this a few ms ahead so the resulting `scroll`
  event is ignored instead of bouncing back. Windows differ by mode (120ms exact,
  up to 600ms ratio) because ratio settling takes longer.
- **`scroll-behavior: auto !important`** is forced into each frame's
  document/body (`attachFrameBehavior`) so programmatic jumps are instant — smooth
  scrolling would desync the panes.

### 5.2 Two modes (and the overlay override)

- **`exact`** — both panes share the same pixel `scrollTop`, clamped to the
  *smaller* scrollable range (`alignSide` / `setLinkedScroll`). Best for
  near-identical builds.
- **`ratio`** — map source scroll fraction onto the target's range. Uses
  `requestAnimationFrame` plus settle timers (80ms, 240ms) to re-align after the
  target's layout stabilizes (lazy images, late fonts).

**Overlay forces locking.** Two `let`-free helpers gate the whole subsystem:
`linked()` = `syncScroll || stacked()` and `effScrollMode()` = `stacked() ?
'exact' : scrollMode`, where `stacked()` is `viewMode === 'overlay'`. Every
`syncScroll`/`scrollMode` check in the wheel, keydown, `syncFrom`, and
`applyScrollPresentation` paths goes through these — so Overlay/Diff always
pixel-lock and hide scrollbars regardless of the user's toggle (an unlocked
overlay is illegible). The user's `syncScroll` preference is read, never
mutated, by entering overlay.

### 5.3 Input interception

`attachFrameBehavior(side)` (run once per frame document, guarded by a
`WeakSet`) installs:
- `wheel` (capture, non-passive) → `preventDefault`, compute target Y via
  `wheelPixels` (normalizes line/page delta modes), drive both panes.
- `keydown` → arrows / space / PageUp/Down / Home / End mapped to linked scroll;
  **and** the global shortcuts (`r/s/0//`) so they work with focus *inside* a
  pane.
- `scroll` (passive) → `syncFrom(side)` when this side owns scrolling.

> **Invariants:**
> 1. Every programmatic `scrollTop` write must be preceded by setting
>    `suppressScrollUntil` for the pane being written. Skipping this reintroduces
>    the feedback loop.
> 2. `attachFrameBehavior` must remain idempotent (the `attachedDocuments`
>    WeakSet). It's called on every `load`, including reload-free solo swaps.
> 3. Capture listeners that set `scrollOwner` must stay `passive` — they observe,
>    they don't prevent.

---

## 6. State model

Three tiers, with a fixed precedence resolved at init by `queryOrStoredBool` and
the explicit `params.get(...) ?? localStorage.getItem(...)` reads:

```
URL query param   >   localStorage   >   built-in default
```

- **URL query** — shareable, reproduces a view. Mirrored via `setUrlParam` /
  `saveBool` (which also write localStorage). Carries: `path`, `split`, `swap`,
  `view`, `overlayBlend`, `overlayAmount`, `mode` (mobile), `compact`, `scroll`,
  `scrollMode`, `mirror`, `focus`, `dock`, `notes`.
- **localStorage** — per-machine stickiness across sessions for the same keys
  (still prefixed `site-compare-*` to preserve existing prefs across the rename).
- **In-memory** — the live `let` flags. The layout is **one** value,
  `viewMode ∈ {split, solo, overlay}`, set by `setMode()`; `overlayBlend ∈
  {opacity, difference}` is the Overlay sub-state (Diff). `dockMode`, `mobileMode`,
  `syncScroll`, `scrollMode`, `mirrorLinks`, `focusSide` are orthogonal. The
  handlers are the single writers: mutate memory → persist (URL+storage) → call a
  `render*`. *(Back-compat: a legacy `view=diff` or `overlay=1&overlayBlend=
  difference` URL resolves to `overlay` + `difference` at init.)*

> **Invariant:** state lives in exactly one place per concern. The DOM reflects
> state; it is not the source of truth. A handler's order is always
> *mutate flag → persist → render*, never read-back-from-DOM.

Notes are the deliberate exception — their source of truth is a *file*, not
URL/storage (§8), because they're a multi-writer channel.

---

## 7. Header stripping & the security boundary

`proxy()` removes from every upstream response:

```
content-encoding, content-length, transfer-encoding,
content-security-policy, content-security-policy-report-only,
x-frame-options,
cross-origin-embedder-policy, cross-origin-opener-policy,
cross-origin-resource-policy
```

- The first three are removed because the body is decoded and rewritten — the
  original framing/length is no longer valid.
- The rest are removed so production (which correctly ships `X-Frame-Options`
  and a strict CSP) can be framed next to dev.

This is the entire security argument for why the tool is loopback-only: it
deliberately defeats the protections that stop a page being embedded. The
boundary is "runs on `127.0.0.1`, started by the local user." Do not add a
mode that binds publicly without re-deriving this.

---

## 8. Notes collaboration channel

A multi-writer channel where writers are "the viewer" and "anyone with shell/curl
access" (a teammate, or an AI session). Design priorities: no lost writes, no
clobbering, live propagation.

### 8.1 File as source of truth

`$SITE_COMPARE_NOTES` (default `$TMPDIR/sitedrift-notes.json`). The server
`loadNotes()` reads it **fresh on every request** — so a direct file edit and a
server-applied op compose without the server holding stale state.

### 8.2 Op-based mutation, not list replacement

`POST /notes` carries a single op: `add | remove | toggle | clear`
(`applyNoteOp`). The server reads → mutates → writes → returns the new list.

> **Why ops, not PUT-the-whole-list:** with two concurrent writers, a full-list
> PUT races — writer A's stale list overwrites writer B's just-added note.
> Op-based mutation each read-modify-writes the current file, so concurrent adds
> compose. Keep it this way.

Note schema: `{ id, text, author, route, side, done, ts }`. `id` is
time+random; `route`/`side` make a note point at a specific page/pane — which is
also what makes a rendered note **clickable** (`go(note.route)` + focus) and
**copyable** as a deep link.

### 8.3 Live propagation

The viewer **polls `GET /notes` every 4s**. `applyNotes()` compares a JSON
signature against the last applied list and **only re-renders on change** — so
polling is cheap and doesn't disturb the drawer or a note being composed.
`notesPost()` applies the server's returned list immediately for snappy local
feedback; the poll reconciles everyone else's writes.

> **Footgun:** do not move notes into URL/localStorage "for consistency" with §6.
> The file *is* the channel; that's the whole feature.

### 8.4 Durable export — `POST /notes/save`

The channel file is ephemeral (`$TMPDIR`). When `SITE_COMPARE_VAULT` is set, the
server exposes `POST /notes/save`, which writes `notesMarkdown(loadNotes())` to a
dated `sitedrift-review-<timestamp>.md` in that dir and returns `{ ok, path }`.
The viewer only shows the **Send to vault** button when `config.vault` is true.
This is the loop-closer for a solo operator: review → durable record where
decisions already live, without the notes file having to be durable itself.

### 8.5 Drawer presentation

Independent of the channel: the drawer can **dock** (adds `.app.drawer-dock`,
which insets the whole app via `padding-right: var(--drawer)` so the panes stay
visible and the toolbar's route box absorbs the lost width) or **float**
(overlay; closes on outside click). The compose box auto-grows to content up to
~60vh then scrolls, with a top grip that raises a manual height floor
(`autosizeNote`). Dock state (`dockMode`) suppresses click-out-to-close.

---

## 9. Version/health handshake

`/health` returns `{ dev, live, version }` where `version` is `viewerVersion`
(a module constant). The `site` CLI computes the *expected* health string from
the dev/live URLs and the version it knows, then compares it to the running
server's `/health`:

- match → reuse the running server.
- mismatch (version bumped, or origins changed) → kill/relaunch.

> **Contract:** bump `viewerVersion` whenever the viewer HTML/JS changes in a way
> that requires a fresh server, and keep the CLI's expected-version literal in
> lockstep. A stale server serving an old viewer against a new CLI link is the
> failure this prevents. `brand`/`author`/`notes` are intentionally **excluded**
> from `/health` — changing them does not force a restart.

---

## 10. Extraction map → npm package

The file is currently monolithic. These are the natural module seams; the
boundaries below are already clean (each communicates through small, explicit
interfaces), so extraction is mechanical rather than a rewrite.

```
sitedrift/
  src/
    config.js          // env parsing, cleanBase, startup icon load
    proxy.js           // targetFor, rewriteRootPaths, proxy(), header strip set
    notes.js           // load/save/apply ops, markdown, schema  ← pure, unit-testable
    server.js          // handler routing table, http/https bootstrap
    viewer/
      html.js          // viewerHtml(config) → string (head + body markup)
      styles.css       // lifted out of the template literal
      client/
        state.js       // queryOrStoredBool, setUrlParam, saveBool
        proxy-paths.js // normalizeRoute, proxied, direct, routeFromFrameUrl
        scroll.js      // the §5 controller — the crown jewel, isolate first
        layout.js      // split/solo/overlay/mobile + applyOrder exclusivity
        metadata.js    // renderMetadata, renderMetaDiff, status badges
        notes.js       // poll/post/render drawer
        viewer.js      // wiring + init
    bin/
      site-compare.js  // CLI: arg parse, lifecycle, TLS, the §9 handshake
                       //   (subsumes what the `site compare` wrapper does today)
```

Suggested order of extraction, lowest-risk first:

1. **`notes.js`** — already pure (no DOM, no server globals). Lift it, add unit
   tests for `applyNoteOp` concurrency and `notesMarkdown`. Zero behavior risk.
2. **`proxy.js`** — pure functions over strings + a `fetch`; testable with
   recorded fixtures. Pin the §3.3 referer behavior with a test *here*, since it
   has none today.
3. **`config.js` / `server.js`** — mechanical.
4. **`viewer/` split** — the client code is the bulk; do it last and behind the
   `node --check`-the-inline-script gate (§4) at each step. **Extract
   `scroll.js` as its own unit with the §5 invariants as test names** — if any
   single module deserves a test suite, it's this one.
5. **`bin/site-compare.js`** — fold the CLI's lifecycle/TLS/handshake logic in so
   `npx site-compare` is the whole story; keep env-var launch working for the
   embedded case.

Once split, the only thing standing between this and `npx site-compare` is a
`bin` entry and the build step that re-inlines `styles.css` + `client/*` into
`viewer/html.js` (or ships them as static routes — note this *adds* the asset-
serving the referer rescue currently avoids, so re-test §3.3 after that change).

---

## 11. Invariant cheat-sheet

Quick reference for "things that look removable but aren't":

- Referer rescue must precede the viewer fallback (§3.3).
- Every programmatic scroll write sets `suppressScrollUntil` first (§5.3).
- `attachFrameBehavior` stays idempotent via the WeakSet (§5.3).
- Notes use op-based POST, never full-list replacement (§8.2).
- Notes live in the file, not URL/storage (§8.3).
- `<` is escaped in the injected `config` JSON (§4).
- `accept-encoding` is dropped before proxying so the body is rewritable (§3.4).
- Bump `viewerVersion` + the CLI literal together (§9).
- No npm dependencies without a deliberate trade-off (§1).

---

## 12. Audit — problems & ideas

A triage list from an audit pass. **Problems** are arguably-wrong or fragile
(most verified against the current code); **ideas** are opportunities, not
defects. Severity: 🔴 high · 🟠 medium · 🟡 low · 💡 idea.

> **Update — resolved:** **P1–P8 are fixed** and **I1 (difference-blend overlay)
> is implemented**. They're kept below as a record of the reasoning and fix.
> **I2–I10 remain open** *(note I9 is partly addressed — the CLI prints the notes
> path, the viewer still doesn't).*
>
> **Shipped since this audit** (not in the list below): the unified
> Split/Solo/Overlay view switch with Diff as the overlay blend; forced
> scroll-lock in overlay (§5.2); the per-pane **SEO** checklist + flag; clickable
> /copyable notes (§8.2); the dock/float drawer (§8.5); and **Send to vault**
> (§8.4). These superseded several rough edges the audit would otherwise list.

### Problems (resolved)

**P1 🟠 Notes endpoint is CSRF-able from any local web page.**
`POST /notes` parses the body as JSON regardless of `Content-Type`. A
`text/plain` body is a CORS "simple request" — **no preflight** — so any site the
user has open can `fetch('http://127.0.0.1:4178/notes', {method:'POST',
body:'{"op":"clear"}'})` and wipe/inject notes. Local- and notes-only, so bounded,
but a real cross-site write. *Fix:* require `Content-Type: application/json`
(forces a preflight the server fails, since it sends no CORS headers) and/or check
`Origin`/`Host` is loopback. (`handler` `/notes` → `applyNoteOp`.)

**P2 🟠 `application/json` responses are URL-rewritten.**
`rewriteRootPaths` runs on JSON; the `_astro`/`@vite` rule can match string
values in real API JSON and corrupt payloads. Needed for Vite dev manifests,
risky for live JSON. *Fix:* scope JSON rewriting to dev, or to known manifest
paths, or drop JSON and special-case Vite. (See §3.2.)

**P3 🟡 Status badges go stale after a reload.**
Reload button/`R` call `contentWindow.location.reload()` and never re-run
`fetchStatus`, so the chips keep their pre-reload value. *Fix:* call
`fetchStatus` in the reload handler, or move it into the frame `load` handler so
it always tracks the rendered page.

**P4 🟡 Non-atomic notes write can flash empty on a concurrent read.**
`saveNotes` is a plain `writeFileSync`; a poll landing mid-write reads a truncated
file, `JSON.parse` throws, the catch returns `[]`, and the drawer briefly empties.
*Fix:* write to `notesFile + '.tmp'` then `fs.renameSync` (atomic same-fs).

**P5 🟡 Status check double-fetches every page.**
`fetchStatus` does a full `GET` per side on every navigation, on top of the
iframe load. *Fix:* `HEAD` (fall back to `GET` on 405), or only fetch when the
frame errors.

**P6 🟡 `document.title` can go stale after a swap.**
Title is set only when `side === order[0]` in `renderMetadata`; swapping changes
`order` without a reload. *Fix:* recompute from cached `meta[order[0]]` in the
swap handler.

**P7 🟡 `--note` seeding duplicates on every run.**
The CLI POSTs each `--note` on startup and notes persist across runs. *Fix:*
dedupe on `(text, route, author)` in `applyNoteOp`, clear-before-seed when
`--note` is present, or document it.

**P8 🟡 Broken-image favicon when a site has no `/favicon.ico`.**
Fallback is `/__<side>/favicon.ico`. *Fix:* `onerror` on the favicon images to
swap to `/icon.svg` or hide.

### Ideas

**I1 ✅ `mix-blend-mode: difference` overlay — the real pixel-diff.** *Implemented.*
A **Diff** toggle in the overlay slider switches the top pane to
`mix-blend-mode: difference` over a black stage: differing pixels light up,
identical pixels go black. Persisted via `overlayBlend` (URL + localStorage);
CLI `--overlay-diff`.

**I2 💡 Pause polling when hidden / drawer closed.** Gate
`setInterval(notesPull, 4000)` on `document.visibilityState` (and optionally only
while the drawer is open).

**I3 💡 `aria-live` on status / metadata-diff changes.** Announce "LIVE returned
404" / "title differs" so the comparison signals are accessible.

**I4 💡 Collapse the duplicated `≠ meta` chip.** It renders on both labels
(redundant). Use one centered indicator, or have each side describe *its* delta.

**I5 💡 Notes file rotation.** Add a `clear --done` op and/or a soft cap so
long-lived sessions stay tidy.

**I6 💡 Runtime `fetch`/import rewriting for SPA support.** An injected shim
patching `fetch`/`XHR`/`URL` in each frame would lift the "static sites only"
limit (§3.2). Bigger lift; do it when a real SPA forces it.

**I7 💡 Tests before extraction.** None exist. On extraction (§10), prioritize:
`applyNoteOp` concurrency, `rewriteRootPaths` fixtures, the §3.3 referer-rescue
branch (untested, easy to break), and the scroll suppress-window behavior.

**I8 💡 Configurable metadata-diff sensitivity.** Exact-string today; offer
ignore-whitespace and canonical path-only vs full-URL to cut false positives
between environments.

**I9 💡 Surface the notes-file path in the viewer.** The CLI prints it; a
browser-only user can't see where notes live. Show `$SITE_COMPARE_NOTES` in the
Help card.

**I10 💡 "Open both at this route."** One action to open/copy both direct URLs,
for handing a specific page to someone outside the tool.

### Non-issues considered (and why they're fine)

- **SSRF via proxy paths** — `targetFor` builds URLs relative to fixed
  `devBase`/`liveBase`; `new URL` normalization prevents escaping the origin. The
  referer rescue re-prefixes only to dev/live. Not exploitable.
- **`</script>` breakout in injected config** — handled: `<` → `<` in the
  `config` JSON.
- **Scroll feedback loop** — handled by `scrollOwner` + `suppressScrollUntil`
  (§5). Left intact.
