# Hosted previews on Cloudflare

sitedrift can turn every non-production Cloudflare deployment of a static site
into a review of itself against production. The preview build is DEV, the
production origin is LIVE. Production builds are left byte-for-byte unchanged.

It takes two project changes and no dashboard settings, bindings, or secrets.

## Cloudflare Pages

### Astro, Vite, Eleventy, or any static build

1. Install:

   ```bash
   npm install --save-dev sitedrift
   ```

2. Scaffold the Pages Function:

   ```bash
   npx sitedrift cloudflare init --live https://example.com
   ```

   This writes `functions/__sitedrift/[[path]].ts` (`--js` for `.js`):

   ```ts
   export { onRequest } from 'sitedrift/cloudflare';
   ```

3. Wrap the build output after your framework build:

   ```json
   {
     "scripts": {
       "build": "astro build && sitedrift cloudflare --live https://example.com"
     }
   }
   ```

Commit both changes and push a branch. The branch URL opens in Solo on DEV and
switches to Split, Overlay, or Diff against production.

`--dir` is auto-detected from the common output folders (`dist`, `_site`,
`build`, `public`, `out`, `.output/public`, `.vercel/output/static`). Pass it
when yours differs:

| Framework | Build command | Output |
|---|---|---|
| Astro | `astro build` | `dist` |
| Vite | `vite build` | `dist` |
| Eleventy | `eleventy` | `_site` |
| Plain HTML | your copy step, or none | the folder Pages serves |

A plain static site with no build step still needs one: set the Pages build
command to `npx sitedrift cloudflare --dir public --live https://example.com`
(with `sitedrift` in `devDependencies`) so the wrap runs on each preview.

### Keep flags out of the build line

Every option can live in `sitedrift.config.json` or a `"sitedrift"` key in
`package.json`. Flags still win.

```json
{
  "sitedrift": {
    "live": "https://example.com",
    "dir": "dist",
    "productionBranch": "main",
    "brand": "Example",
    "nonce": "__CSP_NONCE__"
  }
}
```

The build line is then just `astro build && sitedrift cloudflare`.

## Cloudflare Workers with static assets

The same build step works on Workers Builds (`WORKERS_CI=1`,
`WORKERS_CI_BRANCH`). Point a Worker at sitedrift's handler and let it run
first for `/__sitedrift/*`:

```ts
// src/worker.ts
export { default } from 'sitedrift/cloudflare';
```

```jsonc
// wrangler.jsonc
{
  "name": "example",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-01",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": ["/__sitedrift/*"]
  }
}
```

If you already have a Worker, call the handler for that path and keep your own
routing for the rest:

```ts
import { createPreviewHandler } from 'sitedrift/cloudflare';

const sitedrift = createPreviewHandler();

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith('/__sitedrift/')) return sitedrift.fetch(request, env);
    return env.ASSETS.fetch(request);
  },
};
```

## Strict CSP sites

The viewer writes no inline executable script: its config is an inert
`<script type="application/json">` block, and the frame bridge is an external
file (`/__sitedrift/assets/bridge.js`). With `--nonce`, every script, style,
and stylesheet tag sitedrift writes carries that nonce, and so does the bridge
it injects into framed pages.

If your middleware swaps a build-time placeholder for a per-request nonce, pass
the placeholder:

```bash
sitedrift cloudflare --live https://example.com --nonce __CSP_NONCE__
```

The handler reads the nonce from the build, so the Function stays one line. In
framed pages it also rewrites the nonce on every script and style tag that
already has one. A LIVE page arrives with the nonce production issued, which
would not match the preview's policy; after the rewrite, exactly the tags
production trusted are trusted on the preview. Tags without a nonce stay
without one.

If you mint nonces in the Function itself, pass a function instead:

```ts
import { createPreviewHandler } from 'sitedrift/cloudflare';

export const onRequest = createPreviewHandler({
  nonce: (request) => request.headers.get('x-csp-nonce') ?? undefined,
}).onRequest;
```

The viewer and bridge use no HTML sinks (`innerHTML` and similar), so they run
under `require-trusted-types-for 'script'`. They also work with
`'strict-dynamic'` once nonced. Your policy needs `img-src data:` for the
neutral favicon fallback and `frame-src 'self'`.

## Handler options

`createPreviewHandler(options)` returns `{ onRequest, fetch }`. The default
export and `onRequest` use the defaults below.

| Option | Default | Purpose |
|---|---|---|
| `live` | the build's `--live` | Production origin for LIVE. |
| `productionBranch` | the build's, else `main` | 404 when the runtime reports this branch. |
| `productionHosts` | `[]` | Extra hosts that answer 404. The live host and its `www.` variant always do. |
| `nonce` | the build's `--nonce` | String, or `(request) => string`, stamped as described above. |
| `forwardHeaders` | `DEFAULT_FORWARD_HEADERS` | Request headers sent upstream. |
| `securityHeaders` | `DEFAULT_SECURITY_HEADERS` | Merged onto proxied responses; `false` sets none. |

`DEFAULT_FORWARD_HEADERS` is `accept`, `accept-language`, `user-agent`,
`if-none-match`, `if-modified-since`, `range`. `DEFAULT_SECURITY_HEADERS` is
`X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy: same-origin`, and
`Cross-Origin-Resource-Policy: same-origin`. Both are exported.

## Build options

| Flag | Config key | Default | Purpose |
|---|---|---|---|
| `--live <url>` | `live` | required | Production origin. HTTPS only (loopback allowed for testing). |
| `--dir <dir>` | `dir` | auto-detected | Build output to wrap. |
| `--production-branch <name>` | `productionBranch` | `main` | Builds on this branch are untouched. |
| `--nonce <value>` | `nonce` | none | Nonce or placeholder for every tag sitedrift writes. |
| `--brand <text>` | `brand` | none | Strip `\| <text>` from page titles. |
| `--config <file>` | | discovered | Read a specific config file. |

The Node API exposes the same step: `import { installCloudflarePreview } from 'sitedrift'`.

## Security model

- The handler owns only `/__sitedrift/*`. Everything else keeps its route.
- Only `GET` and `HEAD`. Anything else is `405`.
- LIVE is fixed to the configured origin; a path cannot escape it. A LIVE
  redirect to another origin is not followed; the frame shows where it went.
- Production receives only the forward allowlist. Cookies (including
  Cloudflare Access's `CF_Authorization`), `authorization`,
  `cf-access-client-id`, `cf-access-client-secret`, and forwarding headers are
  never sent. LIVE's `set-cookie` is dropped.
- On the production host, on the production branch, and on any build without
  sitedrift's generated config, the handler answers `404`.
- Upstream CSP and framing headers are stripped so LIVE can be framed, then the
  security headers above are restored. Your own middleware still applies its
  CSP to the response.
- Responses carry `X-Robots-Tag: noindex, nofollow`.
- Review notes stay in the browser's `localStorage`. They are not sent anywhere.

**The iframe sandbox is not isolation.** Hosted frames are same-origin with
the viewer and use `allow-scripts allow-same-origin` so the compared site
behaves like the deployment. On one origin, that combination lets a framed page
reach the viewer, the other frame, and the preview origin's storage. The
review runs your preview's code and your production pages' code on the preview
origin: use it for code you would already run there.

### Previews behind Cloudflare Access

Access works unchanged: the browser authenticates to the preview as usual, and
sitedrift never forwards the Access cookie or service-token headers to
production. If production itself sits behind Access, LIVE will show the Access
login page; sitedrift does not carry credentials across.

## Production guard

The wrapper runs only when all of these are true:

- `CF_PAGES=1` (Pages) or `WORKERS_CI=1` (Workers Builds)
- the branch variable (`CF_PAGES_BRANCH` or `WORKERS_CI_BRANCH`) is set
- the branch is not the production branch

Otherwise it exits without touching the output. To prove it in CI:

```bash
CF_PAGES=1 CF_PAGES_BRANCH=main npm run build
test ! -e dist/__sitedrift
```

## What a build produces

- Every `*.html` except `404.html` is replaced by the viewer, and the original
  is kept at `__sitedrift_source/<file>.html.txt`.
- `404.html` files stay as built, so a missing route shows your real error page
  instead of a nested viewer.
- `__sitedrift/assets/` holds the viewer, bridge, and icon.
- `__sitedrift/config.json` holds `live`, `productionBranch`, and `nonce`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `sitedrift: unchanged (not a Cloudflare preview build)` | Expected locally. To test the wrap, run with `CF_PAGES=1 CF_PAGES_BRANCH=test`. |
| `/__sitedrift/...` returns 404 on the preview | The build did not wrap (check the build log for `wrapped N HTML files`), or the Function file is missing. |
| LIVE shows "redirected to ... outside ..." | Production redirects to another origin, usually `www.` or the apex. Set `--live` to the final origin. |
| LIVE shows a login page | Production requires authentication. sitedrift does not forward credentials. |
| Scripts blocked by CSP in the console | Pass `--nonce` with the value or placeholder your middleware replaces, and allow `img-src data:` and `frame-src 'self'`. |
| Assets missing on LIVE | A script builds a URL at runtime (`fetch('/api')`). The rewriter covers HTML, CSS, `/_astro/` paths, and Vite's dynamic-import list only. |
| Timing differs a lot between sides | Both sides are measured through the proxy in your browser. Compare deltas, not absolute numbers. |

## Upgrading from 0.3

- The Function line is unchanged: `export { onRequest } from 'sitedrift/cloudflare';`.
- Header filtering, the production-host 404, security headers, and nonce
  stamping are now built in. Delete any wrapper Function that did those.
- Viewer pages no longer contain `window.__SITEDRIFT_CONFIG__` or an inline
  bridge script, so scripts that matched them can go.
- `404.html` is no longer wrapped.
- Node 24 or newer is required to run the CLI.
