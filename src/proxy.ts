import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { send } from './http.ts';
import type { ResponseLike } from './http.ts';
import { VIEWER_VERSION } from './viewer.ts';
import { bridgeTag, decodeBytes, injectBridge, rewriteRootPaths, utf8ContentType } from './frame-content.ts';
import { DEFAULT_FORWARD_HEADERS, cleanResponseHeaders, pickHeaders, proxiedLocation } from './headers.ts';
import type { Side } from './wire.ts';

export const BRIDGE_PATH = '/__sitedrift/assets/bridge.js';

/** What the proxy needs from a request: its headers and method, and its body when it has one. */
export interface ProxyRequest extends AsyncIterable<Uint8Array> {
  headers: IncomingHttpHeaders;
  method?: string | undefined;
}

export type ProxyFn = (req: ProxyRequest, res: ResponseLike, side: Side, requestUrl: URL) => Promise<void>;

/**
 * Request headers for an upstream. DEV is the user's own local server and gets
 * the browser's headers (cookies included) so local sessions work. LIVE is
 * production and gets only the content-negotiation allowlist.
 */
function upstreamHeaders(req: Pick<IncomingMessage, 'headers'>, side: Side, target: URL): Headers {
  const get = (name: string): string | undefined => {
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
export function createProxy({ devBase, liveBase }: { devBase: URL; liveBase: URL }): { proxy: ProxyFn } {
  const bases: Record<Side, URL> = { dev: devBase, live: liveBase };
  for (const [name, base] of Object.entries(bases)) {
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error(`${name} proxy origin must be an HTTP(S) URL without credentials.`);
    }
  }

  function targetFor(side: Side, pathname: string, search: string): URL {
    const base = bases[side];
    const relative = pathname.replace(new RegExp(`^/__${side}(?=/|$)`), '') || '/';
    const target = new URL(base);
    target.pathname = relative;
    target.search = search;
    if (target.origin !== base.origin) throw new Error('Proxy target escaped its configured origin.');
    return target;
  }

  const proxy: ProxyFn = async (req, res, side, requestUrl) => {
    const method = req.method || 'GET';
    if (side === 'live' && !['GET', 'HEAD'].includes(method)) {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('sitedrift: the LIVE proxy is read-only.');
      return;
    }
    const target = targetFor(side, requestUrl.pathname, requestUrl.search);
    const prefix = `/__${side}`;

    try {
      const init: RequestInit = { method, headers: upstreamHeaders(req, side, target), redirect: 'manual' };
      if (!['GET', 'HEAD'].includes(method)) {
        // Only reachable for DEV: the user's own server receives form posts.
        init.body = req;
        // Node's fetch requires this opt-in when streaming an incoming request.
        init.duplex = 'half';
      }
      // lgtm[js/request-forgery] -- target is constrained to the configured origin above.
      const upstream = await fetch(target, init);
      const cleaned = cleanResponseHeaders(upstream.headers, target.pathname);
      cleaned.delete('x-robots-tag');
      const responseHeaders: Record<string, string | string[]> = Object.fromEntries(cleaned);
      // Local DEV sessions keep their cookies; LIVE never sets any.
      const cookies = upstream.headers.getSetCookie();
      if (side === 'dev' && cookies.length) responseHeaders['set-cookie'] = cookies;

      const location = upstream.headers.get('location');
      if (location) {
        const mapped = proxiedLocation(location, target, prefix);
        if (!mapped) {
          delete responseHeaders['location'];
          responseHeaders['content-type'] = 'text/plain; charset=utf-8';
          res.writeHead(upstream.status, responseHeaders);
          res.end(method === 'HEAD' ? undefined : `sitedrift: ${side.toUpperCase()} redirected to ${new URL(location, target).href}, outside ${target.origin}. Point --${side} at the final origin.`);
          return;
        }
        responseHeaders['location'] = mapped;
      }

      const type = upstream.headers.get('content-type') || '';
      // Rewrite markup/CSS/JS always; rewrite JSON only on the dev side (Vite
      // manifests) so live API payloads with path-like strings aren't corrupted.
      const rewritable = /text\/html|text\/css|javascript/i.test(type)
        || (side === 'dev' && /application\/json/i.test(type));
      if (rewritable && method !== 'HEAD') {
        let body = rewriteRootPaths(decodeBytes(await upstream.arrayBuffer(), type), prefix, { script: /javascript/i.test(type) });
        if (/text\/html/i.test(type)) {
          body = injectBridge(body, bridgeTag({ src: `${BRIDGE_PATH}?v=${VIEWER_VERSION}`, side, prefix }));
        }
        responseHeaders['content-type'] = utf8ContentType(type);
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
  };

  return { proxy };
}
