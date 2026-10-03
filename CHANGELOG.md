# Changelog

## 0.4.0

### Security

- The hosted LIVE proxy forwards only `accept`, `accept-language`,
  `user-agent`, `if-none-match`, `if-modified-since`, and `range`. Cookies
  (including Cloudflare Access's `CF_Authorization`), `authorization`, and
  `cf-access-client-*` no longer reach production. LIVE `set-cookie` is dropped.
- The local LIVE proxy applies the same allowlist and accepts only `GET` and
  `HEAD`. DEV, your own server, still gets the full request.
- The hosted handler answers 404 on the production host (the live host and its
  `www.` variant), on the production branch when the runtime reports it, and on
  builds without sitedrift's config.
- Proxied responses get `X-Frame-Options: SAMEORIGIN`, `nosniff`,
  `Referrer-Policy`, COOP, and CORP back after the upstream framing headers
  are stripped.
- A redirect to another origin (hosted or local) is no longer handed to the frame; it
  shows where the redirect pointed.
- Docs state plainly that the same-origin iframe sandbox is not isolation.

### Strict CSP

- The viewer config is inert JSON (`<script type="application/json"
  id="sitedrift-config">`), and the frame bridge is an external asset
  (`/__sitedrift/assets/bridge.js`) configured by `data-` attributes.
- `--nonce <value>` (or `nonce` in config) stamps every script, style, and
  stylesheet tag sitedrift writes, including the injected bridge. In framed
  pages the handler rewrites existing nonces to the preview's value.
- No HTML sinks in the viewer or bridge, so Trusted Types policies pass.

### Hosted previews

- `createPreviewHandler({ live, productionBranch, productionHosts, nonce,
  forwardHeaders, securityHeaders })` returns `{ onRequest, fetch }`.
- Workers with static assets: `export { default } from 'sitedrift/cloudflare'`,
  and the wrapper recognizes `WORKERS_CI` / `WORKERS_CI_BRANCH`.
- `404.html` files are left unwrapped. DEV serves source copies regardless of
  method or `Accept`, maps `/x/index.html` directly, and never nests the viewer
  for a missing route, so status checks measure the real page.
- Hashed assets (`/_astro/` or upstream `immutable`) keep their cache policy;
  pages stay `no-store`.
- Vite's dynamic-import preload list (`"_astro/chunk.js"` joined to base `/`)
  is rewritten, so lazy chunks load from the right side.
- The preview config is read once per request.

### Viewer

- Removed the stray pane border that showed as a dark line on the right edge in
  Solo, and the closed notes drawer no longer casts a shadow.
- Solo: only the visible pane drives scrolling; the hidden pane is aligned when
  swapped in. `S` swaps, and the compact Swap button says so.
- The response popover labels timings as measured through the proxy.

### Packaging and tooling

- Node 22 or newer. CI runs Node 22 and 24 and `tsc` type checks.
- Typed exports: `sitedrift` (Node build helpers) and `sitedrift/cloudflare`,
  each with a `types` condition, plus `./package.json`.
- Project config can live in a `"sitedrift"` key in `package.json`, and the
  `cloudflare` command reads `live`, `dir`, `productionBranch`, `brand`, and
  `nonce` from it.
- The npm tarball no longer ships `docs/images` (about 1.2 MB smaller).
- Release publishing installs npm 11.5 or newer for trusted publishing.

### Breaking changes

- Node 18 and 20 are no longer supported.
- Viewer pages no longer define `window.__SITEDRIFT_CONFIG__` or inline the
  bridge. Anything that scraped or patched that markup must be removed.
- Hosted responses now carry the default security headers; pass
  `securityHeaders: false` to opt out.
- Hosted LIVE requests no longer carry cookies or auth headers. Add names to
  `forwardHeaders` if production needs one of the safe ones you rely on.
- The local LIVE proxy rejects non-`GET`/`HEAD` requests with 405.
- `404.html` is served as built instead of wrapped.
- `parseCommand(['cloudflare', ...])` no longer throws when `--live` is
  missing; `resolveCloudflareCommand` does, after reading the config file.
