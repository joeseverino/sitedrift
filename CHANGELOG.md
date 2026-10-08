# Changelog

## Unreleased

### TypeScript

- The code is strict TypeScript. The package ships compiled ESM and `.d.ts`
  files from `dist/`, and the public types (`PreviewHandlerOptions`,
  `PreviewHandler`, `InstallOptions`, `InstallResult`, and the rest) are
  generated from the sources instead of hand-written in `types/`. Imports,
  CLI flags, MCP tools, and the served asset URLs are unchanged.
- The `sitedrift` and `sitedrift-mcp` bins point at `dist/sitedrift.js` and
  `dist/sitedrift-mcp.js`. A one-line `sitedrift.mjs` remains at the package
  root for tooling that runs `node_modules/sitedrift/sitedrift.mjs`.
- The viewer and bridge scripts are TypeScript under `browser/`, compiled for
  the browser into the same `/viewer.js` and `/__sitedrift/assets/bridge.js`
  assets. They stay classic external scripts, so strict-CSP pages are
  unaffected. The viewer cache version is 37.
- `npm run typecheck` is now `npm run check:types`; `npm run build:package`
  builds `dist/`, and `prepack` runs it.
- The tsconfigs enable `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, `noUnusedParameters`, and `noImplicitReturns`.

### Node platform APIs

- Option parsing uses `node:util` `parseArgs` in strict mode. Flags, short
  aliases, error messages, and exit codes are unchanged. Boolean flags accept
  `--no-<flag>` as well as `--flag=false`.
- Hosted wrapping finds pages with `fs.globSync`. The MCP watcher and tests
  use `node:timers/promises`, `URL.parse` and `URL.canParse` replace
  try/catch URL checks, and the test fetch stub uses `t.mock.method`.

### Viewer design

- The stylesheet defines its colours once as named tokens and follows the
  system theme with `color-scheme: light dark` and `light-dark()`. Text,
  muted text, the accent, and the focus ring meet WCAG AA in both themes.
- One deep-blue accent marks the active control, the LIVE label, the focus
  ring, and the slider. DEV and LIVE are told apart by their labels.
- Status chips are neutral with a small dot. Red and amber appear only for
  errors, redirects, and metadata that differs.
- Note authors are plain text. Radii, shadows, and spacing use one quiet
  scale, and the interface uses the system UI and monospace font stacks.
- The README screenshots and the visual test fixtures use a restaurant menu
  page instead of a product-analytics landing page.

### Fixes

- Server errors answer with a fixed message (`internal error`, `invalid JSON`, `could not write the review file`) and the detail goes to stderr; note validation errors still return their own message.
- The overlay opacity defaults to 50 when no value is stored or in the URL;
  `overlayAmount=0` still selects 0.
- Upstream HTML, CSS, and JavaScript are decoded with the declared charset
  (UTF-8 when absent or unknown) in the local proxy and the Cloudflare runtime,
  and served as UTF-8.
- A request such as `GET //` no longer crashes the server. An invalid request
  target answers 400, and any other error in a handler answers 500.
- Note bodies are read as bytes, so a multibyte character split across network
  chunks is no longer corrupted, and the 1 MB limit counts bytes.
- Running `sitedrift cloudflare` again on the same output no longer replaces
  the preserved source pages with the wrapped viewer.
- A missing browser opener (`xdg-open`) no longer crashes the server when
  `--open` is used.
- Boolean flags honor an explicit value: `--open=false` and `--https=0` turn the
  setting off instead of on.
- `/__devtools` and other paths that only start with `/__dev` or `/__live` are
  no longer treated as proxy routes.
- MCP: notifications never get a response, invalid requests answer `-32600`,
  tool arguments are validated before a session is looked up, and an unknown
  tool is reported as such.
- Config values of the wrong type (`"brand": 42`) are rejected with the key
  name. Entries in the notes file that are not notes are ignored.
- The generated local TLS directory is `0700` and the key `0600`. Cached
  certificates and keys are unchanged.
- The control client explains a refused connection (a stale session file)
  instead of printing a bare socket error.
- Missing viewer assets raise an error at startup instead of serving blank
  pages.

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

- Node 24 or newer. CI runs Node 24 and `tsc` type checks.
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
