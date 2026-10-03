import { send } from './http.mjs';
import { VIEWER_VERSION } from './viewer.mjs';
import { bridgeTag, injectBridge, rewriteRootPaths } from './frame-content.mjs';
import { DEFAULT_FORWARD_HEADERS, cleanResponseHeaders, pickHeaders, proxiedLocation } from './headers.mjs';

export const BRIDGE_PATH = '/__sitedrift/assets/bridge.js';

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 */

/**
 * Request headers for an upstream. DEV is the user's own local server and gets
 * the browser's headers (cookies included) so local sessions work. LIVE is
 * production and gets only the content-negotiation allowlist.
 * @param {IncomingMessage} req
 * @param {'dev' | 'live'} side
 * @param {URL} target
 * @returns {Headers}
 */
export function upstreamHeaders(req, side, target) {
  /** @param {string} name */
  const get = (name) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value.join(', ') : value;
  };
  if (side === 'live') return pickHeaders(get, DEFAULT_FORWARD_HEADERS);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || ['host', 'accept-encoding', 'connection'].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('host', target.host);
  return headers;
}

// Reverse-proxies the two origins under /__dev/* and /__live/*, rewriting
// root-relative URLs so both sites render framed side-by-side. Strips
// framing/isolation headers, so it is safe for loopback development only.
/** @param {{ devBase: URL, liveBase: URL }} options */
export function createProxy({ devBase, liveBase }) {
  for (const [name, base] of /** @type {const} */ ([['dev', devBase], ['live', liveBase]])) {
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error(`${name} proxy origin must be an HTTP(S) URL without credentials.`);
    }
  }

  /**
   * @param {'dev' | 'live'} side
   * @param {string} pathname
   * @param {string} search
   */
  function targetFor(side, pathname, search) {
    const base = side === 'dev' ? devBase : liveBase;
    const relative = pathname.replace(new RegExp(`^/__${side}`), '') || '/';
    const target = new URL(base);
    target.pathname = relative;
    target.search = search;
    if (target.origin !== base.origin) throw new Error('Proxy target escaped its configured origin.');
    return target;
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {'dev' | 'live'} side
   * @param {URL} requestUrl
   */
  async function proxy(req, res, side, requestUrl) {
    const method = req.method || 'GET';
    if (side === 'live' && !['GET', 'HEAD'].includes(method)) {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('sitedrift: the LIVE proxy is read-only.');
      return;
    }
    const target = targetFor(side, requestUrl.pathname, requestUrl.search);
    const prefix = `/__${side}`;

    try {
      /** @type {RequestInit & { duplex?: 'half' }} */
      const init = { method, headers: upstreamHeaders(req, side, target), redirect: 'manual' };
      if (!['GET', 'HEAD'].includes(method)) {
        // Only reachable for DEV: the user's own server receives form posts.
        init.body = /** @type {any} */ (req);
        // Node's fetch requires this opt-in when streaming an incoming request.
        init.duplex = 'half';
      }
      // lgtm[js/request-forgery] -- target is constrained to the configured origin above.
      const upstream = await fetch(target, init);
      const cleaned = cleanResponseHeaders(upstream.headers, target.pathname);
      cleaned.delete('x-robots-tag');
      /** @type {Record<string, string | string[]>} */
      const responseHeaders = Object.fromEntries(cleaned);
      // Local DEV sessions keep their cookies; LIVE never sets any.
      if (side === 'dev' && upstream.headers.getSetCookie().length) {
        responseHeaders['set-cookie'] = upstream.headers.getSetCookie();
      }

      const location = upstream.headers.get('location');
      if (location) {
        const mapped = proxiedLocation(location, target, prefix);
        if (!mapped) {
          delete responseHeaders.location;
          responseHeaders['content-type'] = 'text/plain; charset=utf-8';
          res.writeHead(upstream.status, responseHeaders);
          res.end(method === 'HEAD' ? undefined : `sitedrift: ${side.toUpperCase()} redirected to ${new URL(location, target).href}, outside ${target.origin}. Point --${side} at the final origin.`);
          return;
        }
        responseHeaders.location = mapped;
      }

      const type = upstream.headers.get('content-type') || '';
      // Rewrite markup/CSS/JS always; rewrite JSON only on the dev side (Vite
      // manifests) so live API payloads with path-like strings aren't corrupted.
      const rewritable = /text\/html|text\/css|javascript/.test(type)
        || (side === 'dev' && /application\/json/.test(type));
      if (rewritable && method !== 'HEAD') {
        let body = rewriteRootPaths(await upstream.text(), prefix, { script: /javascript/.test(type) });
        if (/text\/html/.test(type)) {
          body = injectBridge(body, bridgeTag({ src: `${BRIDGE_PATH}?v=${VIEWER_VERSION}`, side, prefix }));
        }
        res.writeHead(upstream.status, responseHeaders);
        res.end(body);
        return;
      }

      res.writeHead(upstream.status, responseHeaders);
      res.end(method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const nextStep = side === 'dev'
        ? 'Start your development server (usually: npm run dev), then reload.'
        : 'Verify the --live URL is reachable, then reload.';
      send(
        res,
        502,
        `Could not load ${target.href}\n\n${error instanceof Error ? error.message : String(error)}\n\n${nextStep}`,
      );
    }
  }

  return { proxy };
}
