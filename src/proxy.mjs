import { send } from './http.mjs';

// Reverse-proxies the two origins under /__dev/* and /__live/*, rewriting
// root-relative URLs so both sites render framed side-by-side. Deliberately
// strips framing/isolation headers — safe for loopback development only.
export function createProxy({ devBase, liveBase }) {
  function targetFor(side, pathname, search) {
    const base = side === 'dev' ? devBase : liveBase;
    const relative = pathname.replace(new RegExp(`^/__${side}`), '') || '/';
    return new URL(`${relative}${search}`, `${base.href}/`);
  }

  function rewriteRootPaths(body, side) {
    const prefix = `/__${side}`;
    return body
      .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}/`)
      .replace(/\bsrcset=(["'])(.*?)\1/gi, (attribute, quote, value) => {
        const rewritten = value.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`);
        return `srcset=${quote}${rewritten}${quote}`;
      })
      .replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`)
      .replace(/(["'`])\/(@(?:id|vite|fs)\/|_astro\/)/g, `$1${prefix}/$2`);
  }

  async function proxy(req, res, side, requestUrl) {
    const target = targetFor(side, requestUrl.pathname, requestUrl.search);
    const headers = { ...req.headers, host: target.host };
    delete headers['accept-encoding'];
    delete headers.connection;

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        redirect: 'manual',
      });
      const responseHeaders = {};
      upstream.headers.forEach((value, key) => {
        if (![
          'content-encoding',
          'content-length',
          'content-security-policy',
          'content-security-policy-report-only',
          'cross-origin-embedder-policy',
          'cross-origin-opener-policy',
          'cross-origin-resource-policy',
          'transfer-encoding',
          'x-frame-options',
        ].includes(key)) {
          responseHeaders[key] = value;
        }
      });
      responseHeaders['cache-control'] = 'no-store';

      const location = upstream.headers.get('location');
      if (location) {
        const redirected = new URL(location, target);
        if (redirected.origin === target.origin) {
          responseHeaders.location = `/__${side}${redirected.pathname}${redirected.search}${redirected.hash}`;
        }
      }

      const type = upstream.headers.get('content-type') || '';
      // Rewrite markup/CSS/JS always; rewrite JSON only on the dev side (Vite
      // manifests) so live API payloads with path-like strings aren't corrupted.
      const rewritable = /text\/html|text\/css|javascript/.test(type)
        || (side === 'dev' && /application\/json/.test(type));
      if (rewritable) {
        const body = rewriteRootPaths(await upstream.text(), side);
        res.writeHead(upstream.status, responseHeaders);
        res.end(body);
        return;
      }

      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      send(
        res,
        502,
        `Could not load ${target.href}\n\n${error.message}\n\nStart the dev server with: site dev`,
      );
    }
  }

  return { proxy };
}
