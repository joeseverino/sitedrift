# Cloudflare Pages preview addon

Add sitedrift to non-production Cloudflare Pages deployments in two project
changes. Production builds remain byte-for-byte unchanged.

## Quick setup

```bash
npm install --save-dev sitedrift@latest
npx sitedrift cloudflare init --live https://example.com
```

`init` writes the scoped Pages Function for you (`functions/__sitedrift/[[path]].ts`),
detects your build output directory, and prints the exact build line to paste —
something like:

```
sitedrift: created functions/__sitedrift/[[path]].ts
Next, add this to your package.json "build" script, after the framework build:
    sitedrift cloudflare --dir dist --live https://example.com
Then commit both changes and push a preview branch.
```

Paste that into your `build` script so it runs after the framework build:

```json
{
  "scripts": {
    "build": "astro build && sitedrift cloudflare --dir dist --live https://example.com"
  }
}
```

Commit both changes and push a non-production branch. Its Pages URL opens in
compact DEV Solo view and can switch to Split, Overlay, or Diff against
production. That is the whole setup — no dashboard settings or bindings.

Prefer JavaScript over TypeScript for the Function? `init --js` writes
`[[path]].js` instead.

## What `init` does for you, by hand

If you would rather wire it up manually, the two changes are:

1. Add the wrapper after the framework build. `--dir` is auto-detected when
   omitted (the build has already run by then), so you usually only need `--live`:

   ```json
   {
     "scripts": {
       "build": "astro build && sitedrift cloudflare --live https://example.com"
     }
   }
   ```

   It works with any static framework:

   | Framework | Build command | Output dir |
   |---|---|---|
   | Astro | `astro build` | `dist` |
   | Vite | `vite build` | `dist` |
   | Eleventy | `eleventy` | `_site` |
   | Static HTML | your existing command | varies |

2. Create `functions/__sitedrift/[[path]].ts`:

   ```ts
   export { onRequest } from 'sitedrift/cloudflare';
   ```

## What the deployment looks like

The integration uses the normal Pages build. Cloudflare records the repository,
branch, commit, success state, duration, and immutable URL for the reviewed
artifact:

[![Cloudflare deployment details](images/cloudflare-deployment.jpg)](https://6ef83545.jseverino.pages.dev/)

After the framework creates its static output, sitedrift transforms the preview
in place. This real build produced 83 HTML files and then printed:
`sitedrift: wrapped 83 HTML files for Cloudflare preview ...`

![Cloudflare build log showing the sitedrift wrapper](images/cloudflare-build-log.jpg)

The resulting deployment opens directly into sitedrift and compares that
specific preview with the configured production origin:

[![Wrapped Cloudflare preview in Split view](images/cloudflare-preview-result.jpg)](https://6ef83545.jseverino.pages.dev/)

This demonstration uses an immutable `*.pages.dev` URL, so it remains pinned to
the reviewed commit even after the branch changes.

## Production guard

The wrapper activates only when all of these are true:

- `CF_PAGES=1`
- `CF_PAGES_BRANCH` is present
- the branch is not `main`

If production uses another branch:

```bash
sitedrift cloudflare --dir dist --live https://example.com --production-branch production
```

On the production branch, sitedrift returns without changing the build output
or creating its internal files.

## Security model

- The Function owns only `/__sitedrift/*`.
- It accepts only `GET` and `HEAD`.
- The LIVE proxy is fixed to the `--live` origin.
- Existing Pages Functions and application APIs retain their routes.
- Preview pages are marked `noindex`.
- Hosted notes stay in that browser's `localStorage`.
- Compared preview scripts execute inside the frames, so enable the addon only
  for preview code you trust.

No Cloudflare dashboard settings, environment variables, Worker bindings, or
production route changes are required.

## CI check

To prove the production guard in your own project:

```bash
CF_PAGES=1 CF_PAGES_BRANCH=main npm run build
test ! -e dist/__sitedrift
```
