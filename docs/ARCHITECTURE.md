# sitedrift — Architecture

Technical companion to the [README](../README.md). This documents the internals
of the packaged application, the non-obvious decisions, and the invariants that
must hold.

Audience: anyone modifying the proxy, the scroll controller, or the notes
channel. Read the relevant invariants before you "simplify" anything here —
several parts look redundant but are load-bearing.

---

## 1. Shape and constraints

- **Zero runtime dependencies, no build step.** Only Node stdlib (`http`,
  `https`, `fs`, `os`, `child_process`, `url`, `crypto`). This is a hard
  design constraint — do not add dependencies without a deliberate decision to
  give that up. There is no bundler: the source ships as-is and `npx sitedrift`
  runs it directly.
- **Small modules + static assets.** The server is split into focused ES modules
  under `src/`; the viewer ships as real files under `assets/`:

  | File | Responsibility |
  |---|---|
  | `sitedrift.mjs` | bin entry — resolve config, start server, log, `--open`. |
  | `src/cli.mjs` | arg parsing, env resolution, `--help`/`--version`. |
  | `src/server.mjs` | the request handler + http/https server. |
  | `src/proxy.mjs` | reverse proxy + `rewriteRootPaths` (§3). |
  | `src/notes.mjs` | the notes store — load/save/markdown/ops (§8). |
  | `src/agent.mjs` | JSON CLI client for the authenticated control API. |
  | `src/mcp.mjs` | zero-dependency stdio MCP tools, resources, and prompt. |
  | `src/session.mjs` | private session token + discovery file lifecycle. |
  | `src/viewer.mjs` | loads `assets/*`, injects the per-run config blob. |
  | `src/tls.mjs` | `--https` / `--setup-https`: cert resolution via mkcert→openssl. |
  | `src/cloudflare.mjs` | preview-only static-build wrapper + `init` scaffold (auto-detects the output dir). |
  | `src/cloudflare-runtime.mjs` | read-only scoped Pages Function proxy. |
  | `src/frame-content.mjs` | shared URL rewriting and frame bridge injection. |
  | `src/http.mjs` | `send` / `readBody` helpers. |
  | `src/browser.mjs` | cross-platform `--open`. |
  | `assets/viewer.{html,css,js}` | the viewer — edited as real HTML/CSS/JS. |
  | `assets/icon.svg` | served at `/icon.svg`, favicon + toolbar mark. |

  The viewer is static except a single `config` object injected as
  `window.__SITEDRIFT_CONFIG__`. Local mode includes DEV/LIVE, brand/author,
  vault availability, API/token, isolated frame origins, and `hosted: false`;
  hosted mode replaces the control-plane fields with local-notes and initial
  route state. `viewer.css` and `viewer.js` are served as their own cacheable
  routes; `/` returns only the shell (~13 KB instead of the full inline app).
- **It is a loopback development tool**, not a public server. Non-loopback
  bind addresses are rejected. An optional browser hostname supports local DNS
  and TLS names such as `compare.homelab`; Host validation accepts only the
  loopback bind name and that exact alias.

The `site` CLI wrapper (process lifecycle, TLS cert wiring, the version/health
handshake §9) is *not* part of the package surface; the bin is self-launching
via flags or `SITEDRIFT_*` / legacy `SITE_COMPARE_*` env vars.

---

## 2. Process model & request lifecycle

One process starts three `http`/`https` servers. TLS is opt-in:

- **Control origin** on `--port`: viewer, health, authenticated API.
- **DEV frame origin** on `--port + 1`: `/__dev/*` only.
- **LIVE frame origin** on `--port + 2`: `/__live/*` only.

Separate origins prevent proxied scripts from accessing the viewer control
plane or inspecting the opposite side. All listeners use the same TLS material.

```
certFile && keyFile  →  https.createServer({cert, key})
otherwise            →  http.createServer()
```

`handler(req, res)` is a flat routing table, matched in order:

| Match | Handler |
|---|---|
| `/health` | JSON `{ dev, live, version }` — the handshake source (§9). |
| `/api/v1/session` | Authenticated machine context and capabilities. |
| `/api/v1/notes` | Authenticated note list/revision and operation endpoint (§8). |
| `/notes.md` | Markdown render of the list. |
| `/api/v1/notes/save` | Authenticated durable export (§8.4). |
| `/icon.svg` | The startup-loaded SVG, cached 1 day. |
| `/viewer.css`, `/viewer.js` | The viewer assets, cached 1 day. |
| frame `/__dev/*` | `proxy(req, res, 'dev', url)` (§3). |
| frame `/__live/*` | `proxy(req, res, 'live', url)` (§3). |
| _fallback_ | **Referer-based asset rescue**, else the viewer (§3.3). |

There is no router abstraction by design — the table is short and the ordering
is the contract.

---

## 3. Reverse proxy & URL rewriting

The hardest-to-reason-about subsystem. Goal: render two upstream origins under
isolated frame origins, while keeping those origins separate from the viewer
control plane and preserving root-relative links.

### 3.1 Origin mapping

Each side is exposed under a path prefix:

- `devBase` (default `http://127.0.0.1:4321`) → `/__dev/*`
- `liveBase` (required from CLI, environment, or project config) → `/__live/*`

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
> was expected and silently corrupts the framed render. Tests cover listener
> isolation and referer routing; keep those tests aligned with changes here.

### 3.4 Response handling

`proxy()`:
- Forwards the request, **deletes `accept-encoding`** (so upstream returns
  uncompressed text the rewriter can edit) and `connection`.
- Strips a fixed set of headers (§7) from the response.
- Rewrites `Location` on same-origin redirects back into the `/__<side>` space
  so redirects stay inside the comparison.
- Forces `Cache-Control: no-store` — comparisons must always be fresh.

---

## 4. Viewer and frame bridge

The viewer receives one escaped JSON config object, copies it into module
state, and immediately deletes the global. It includes the control API path,
session token, and isolated frame origins.

The viewer cannot read frame DOM. `proxy.mjs` injects a small bridge into HTML
responses. It sends bounded metadata, SEO checks, navigation, keyboard, and
scroll messages to the parent. The parent accepts a message only when both
`event.origin` and `event.source` match the configured frame and iframe.

Parent-to-frame messages are limited to settings, scroll positions, and reload.
No bearer token or filesystem capability crosses into the frame origins.

---

## 5. Locked scroll controller

The most subtle subsystem; the part most likely to regress. Goal: scrolling
either pane moves both, with exactly one authority at a time and no feedback
loops between the two `scroll` event streams.

### 5.1 Concepts

- **`scrollOwner`** — the side currently driving. Any `scroll`/wheel event that
  clears that side's suppress window claims ownership; the counter-scroll we push
  to the other side lands inside *its* suppress window and never claims it. So
  whichever pane the user actually touches becomes the authority, and either pane
  can take over — no pane "owns" scrolling permanently.
- **`suppressScrollUntil[side]`** — a short timestamp gate. When we *programmatically*
  set a pane's `scrollTop`, we set this a few ms ahead so the resulting `scroll`
  event is ignored instead of bouncing back. Windows differ by mode (120ms exact,
  up to 600ms ratio) because ratio settling takes longer.
- The bridge forces `scroll-behavior: auto` before accepting scroll commands so
  programmatic jumps are instant.

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
`syncScroll`/`scrollMode` check in wheel, keydown, `syncFrom`, and frame-setting
paths goes through these, so Overlay/Diff always pixel-lock regardless of the
user's toggle. The user's `syncScroll` preference is read, never mutated, by
entering overlay.

> **Overlay paint-order invariant.** In Overlay the panes are
> `position: absolute` and stacked. The blended pane (`.overlay-top`, which
> carries the opacity blend and `mix-blend-mode: difference`) **must** sit on top
> via `z-index`. Flex `order` reorders layout but *not* paint order for
> absolutely-positioned elements, so without the `z-index` the blend lands on the
> pane painted underneath and Diff/opacity only work in one Swap direction.

### 5.3 Two scroll transports

Side-by-side views (Split/Solo) scroll **natively** — the bridge does *not*
intercept the wheel, so trackpad momentum is preserved. Each pane's native
`scroll` event is mirrored to the other (`syncFrom` → `alignSide`). Overlay is
different: the panes are stacked, so there is no second native scroll to mirror
and pixel-exact lockstep matters for Diff. There the bridge hijacks the wheel
(`preventDefault` + posts a normalized delta) and the parent drives both panes.
The parent tells each frame which transport to use via the `stacked` flag in the
`settings` message; keyboard, click, and `scroll` messages flow in both modes.

> **Invariants:**
> 1. Every programmatic `scrollTop` write must be preceded by setting
>    `suppressScrollUntil` for the pane being written. Skipping this reintroduces
>    the feedback loop.
> 2. Validate both message origin and source before acting.
> 3. Never expose viewer or control routes on the frame listener.

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

The tool deliberately defeats upstream framing protections, so it remains
loopback-only. The boundary also includes Host validation, a separate frame
origin, and bearer-authenticated mutations. Do not add public binding without
re-deriving this.

---

## 8. Notes collaboration channel

A multi-writer channel where writers are "the viewer" and "anyone with shell/curl
access" (a teammate, or an AI session). Design priorities: no lost writes, no
clobbering, live propagation.

### 8.1 File as source of truth

`SITEDRIFT_NOTES` / legacy `$SITE_COMPARE_NOTES` (default
`$TMPDIR/sitedrift-notes.json`). `createNotes().load()` reads it **fresh on every
request** — so a direct file edit and a server-applied op compose without the
server holding stale state.

### 8.2 Op-based mutation, not list replacement

`POST /api/v1/notes` carries one op:
`add | remove | toggle | resolve | reopen | clear`. The server reads, mutates,
writes atomically, and returns the new list plus its revision.

> **Why ops, not PUT-the-whole-list:** with two concurrent writers, a full-list
> PUT races — writer A's stale list overwrites writer B's just-added note.
> Op-based mutation each read-modify-writes the current file, so concurrent adds
> compose. Keep it this way.

Note schema: `{ id, text, author, route, side, done, ts }`. `id` is
time+random; `route`/`side` make a note point at a specific page/pane — which is
also what makes a rendered note **clickable** (`go(note.route)` + focus) and
**copyable** as a deep link.

### 8.3 Live propagation

The viewer **polls `GET /api/v1/notes` every 4s** with its bearer token.
Each response is `{ notes, revision }`, where `revision` is a truncated SHA-256
of the serialized list. It is an opaque change token, not a sequence number.
`applyNotes()` compares a JSON
signature against the last applied list and **only re-renders on change** — so
polling is cheap and doesn't disturb the drawer or a note being composed.
`notesPost()` applies the server's returned list immediately for snappy local
feedback; the poll reconciles everyone else's writes.

The MCP tool `sitedrift_notes_watch` uses the same revision contract. Given a
revision, it polls the authenticated endpoint inside one tool call until the
revision changes or the bounded timeout expires. A change returns
`{ changed: true, revision, notes }`; a timeout returns only
`{ changed: false, revision }`.

> **Lifecycle limit:** MCP watch is long-polling, not a background subscription.
> It saves repeated model-visible list calls while an agent turn is active, but
> it cannot wake a stopped host conversation or autonomously reply after the
> host ends the turn. Continuous autonomous replies require an external agent
> process that owns its own model/API lifecycle.

> **Footgun:** do not move notes into URL/localStorage "for consistency" with §6.
> The file *is* the channel; that's the whole feature.

### 8.4 Durable export — `POST /api/v1/notes/save`

The channel file is ephemeral (`$TMPDIR`). When `SITE_COMPARE_VAULT` is set, the
server exposes the authenticated save endpoint, which writes
`notes.markdown(notes.load())` to a
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

## 9. Session and version handshakes

After both listeners bind successfully, the process writes
`~/.sitedrift/sessions/<port>.json` with mode `0600`. It contains the control
URL, token, origins, notes path, PID, and start time. `sitedrift context` and
`sitedrift notes ...` read this descriptor and call `/api/v1/*`, printing JSON.

`sitedrift mcp` and the `sitedrift-mcp` bin expose the same operations over MCP
stdio. The implementation writes protocol messages only to stdout, supports
tools/resources/prompts, and keeps HTTP credentials inside the local process.
The tool surface includes context, list/watch, add/resolve/reopen/remove/clear,
and setup guidance. `sitedrift_context` must be called first; when no session is
running, capable agents should inspect and launch the project's established dev
and sitedrift commands rather than treating setup text as the end of the task.

`/health` returns `{ dev, live, version }` where `version` is the
`VIEWER_VERSION` module constant. The external `site` wrapper imports that
constant when the module is available, computes the expected health string from
the DEV/LIVE URLs, and compares it to the running server's `/health`:

- match → reuse the running server.
- mismatch (version bumped, or origins changed) → kill/relaunch.

> **Contract:** bump `VIEWER_VERSION` whenever viewer assets change in a way
> that requires a fresh server. Wrappers should read the exported constant
> rather than duplicate it. A stale server serving old assets against a new
> viewer link is the failure this prevents. `brand`/`author`/`notes` are
> intentionally **excluded** from `/health` — changing them does not force a
> restart.

---

## 10. Module layout (extraction — done)

The original single file was split along the seams below (see the table in §1).
The split was proven byte-faithful: the de-templated `assets/viewer.css` and
`assets/viewer.js` were diffed against the previously-rendered viewer and are
identical, so the extraction changed structure, not behavior.

```
sitedrift/
  sitedrift.mjs        // bin entry
  src/
    cli.mjs            // arg parse, env resolution, help/version, cleanBase
    server.mjs         // handler routing table, http/https bootstrap
    proxy.mjs          // targetFor, rewriteRootPaths, proxy(), header strip set
    notes.mjs          // load/save/apply ops, markdown  ← pure, unit-testable
    agent.mjs          // authenticated JSON CLI client
    mcp.mjs            // stdio MCP tools/resources/prompt
    session.mjs        // mode-0600 session descriptor lifecycle
    viewer.mjs         // loads assets/, injects the per-run config blob
    tls.mjs            // explicit/automatic local TLS
    cloudflare.mjs     // preview build wrapper + init scaffold / output-dir detect
    cloudflare-runtime.mjs // scoped read-only Pages proxy
    frame-content.mjs  // shared frame rewriting/bridge injection
    http.mjs           // send / readBody
    browser.mjs        // cross-platform --open
  assets/
    viewer.html        // head + body markup (placeholders __VERSION__/__CONFIG__)
    viewer.css         // lifted out of the template literal
    viewer.js          // the client bundle (state, scroll, layout, notes, init)
    icon.svg
```

Notes on what shipped vs. the original plan:

- **Assets are served as their own routes** (`/viewer.css`, `/viewer.js`), not
  re-inlined — chosen for cacheability and a small `/` shell. This *adds* the
  asset-serving the referer rescue (§3.3) avoids for proxied pages, but these are
  explicit routes matched *before* the fallback, so §3.3 is unaffected. Verified:
  proxying a live route still returns 200 with rewritten paths.
- **No build step** — the source ships as-is; `viewer.mjs` does placeholder
  substitution at request time, not a bundle.

Remaining opportunity (not yet done): `assets/viewer.js` is still one
~1,150-line
file. The §5 scroll controller is the crown jewel and the best first candidate to
split into its own client module with the §5 invariants as test names.

---

## 11. Invariant cheat-sheet

Quick reference for "things that look removable but aren't":

- Referer rescue must precede the viewer fallback (§3.3).
- Every programmatic scroll write sets `suppressScrollUntil` first (§5.3).
- The wheel is hijacked only in Overlay; side-by-side scrolls natively (§5.3).
- In Overlay the blended `.overlay-top` pane stacks on top via `z-index` (§5.2).
- Frame messages validate both origin and source (§4–5).
- The frame listener exposes proxy routes only (§2).
- Notes use op-based POST, never full-list replacement (§8.2).
- Notes live in the file, not URL/storage (§8.3).
- Notes revisions are opaque content hashes, not ordered counters (§8.3).
- MCP watch cannot outlive the host's active tool call/turn (§8.3).
- `<` is escaped in the injected `config` JSON (§4).
- `accept-encoding` is dropped before proxying so the body is rewritable (§3.4).
- Bump exported `VIEWER_VERSION` for viewer asset changes (§9).
- No npm dependencies without a deliberate trade-off (§1).

---

## 12. Audit — problems & ideas

A triage list from an audit pass. **Problems** are arguably-wrong or fragile
(most verified against the current code); **ideas** are opportunities, not
defects. Severity: 🔴 high · 🟠 medium · 🟡 low · 💡 idea.

> **Update — resolved:** **P1–P8 are fixed** and **I1 (difference-blend overlay)
> is implemented**. They're kept below as a record of the reasoning and fix.
> **I2–I6 and I8–I10 remain open** *(I5's 1,000-note cap is shipped, but
> done-note cleanup is not; I9 is partly addressed because the CLI prints the
> notes path while the viewer still does not). I7 is complete.*
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

**I5 💡 Notes file rotation.** A 1,000-note soft cap is implemented. A
`clear --done` operation or archival workflow is still open so long-lived
sessions can discard completed notes without clearing active findings.

**I6 💡 Runtime `fetch`/import rewriting for SPA support.** An injected shim
patching `fetch`/`XHR`/`URL` in each frame would lift the "static sites only"
limit (§3.2). Bigger lift; do it when a real SPA forces it.

**I7 ✅ Tests around the extracted modules.** Implemented for CLI/config,
Cloudflare wrapping/runtime behavior, MCP registration/watch behavior, notes
operations, session URLs, control/frame isolation, and hostname validation.
Remaining high-value gaps are broader `rewriteRootPaths` fixtures and direct
scroll suppress-window tests.

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
