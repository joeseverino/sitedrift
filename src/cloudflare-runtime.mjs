// Edge runtime for hosted previews: Cloudflare Pages Functions and Workers
// with static assets. Serves /__sitedrift/dev/* from the preview's own build
// and /__sitedrift/live/* from the one configured production origin.

import { bridgeTag, checkNonce, injectBridge, restampNonces, rewriteRootPaths } from './frame-content.mjs';
import {
  DEFAULT_FORWARD_HEADERS,
  DEFAULT_SECURITY_HEADERS,
  cleanResponseHeaders,
  pickHeaders,
  proxiedLocation,
} from './headers.mjs';

export { DEFAULT_FORWARD_HEADERS, DEFAULT_SECURITY_HEADERS };

const BRIDGE_SRC = '/__sitedrift/assets/bridge.js';
const VIEWER_MARKER = 'id="sitedrift-config"';

/**
 * @typedef {{ fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> }} AssetsBinding
 * @typedef {{ ASSETS: AssetsBinding, [key: string]: unknown }} PreviewEnv
 * @typedef {{ request: Request, env: PreviewEnv }} PagesContext
 * @typedef {{ live: string, nonce?: string, productionBranch?: string }} PreviewConfig
 * @typedef {{
 *   live?: string,
 *   productionBranch?: string,
 *   productionHosts?: string[],
 *   nonce?: string | ((request: Request) => string | undefined),
 *   forwardHeaders?: readonly string[],
 *   securityHeaders?: Record<string, string> | false,
 * }} PreviewHandlerOptions
 */

const notFound = () => new Response('Not found.', {
  status: 404,
  headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
});

/** @param {string} host */
function hostVariants(host) {
  const bare = host.replace(/^www\./, '');
  return [bare, `www.${bare}`];
}

/**
 * @param {AssetsBinding} assets
 * @param {URL} requestUrl
 * @returns {Promise<PreviewConfig | null>}
 */
async function readConfig(assets, requestUrl) {
  const response = await assets.fetch(new URL('/__sitedrift/config.json', requestUrl));
  if (!response.ok) return null;
  try {
    const value = await response.json();
    return value && typeof value.live === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Source-copy candidates for a DEV route. Every wrapped page keeps its
 * original under /__sitedrift_source/<file>.html.txt.
 * @param {string} pathname
 * @returns {string[]}
 */
export function sourceCandidates(pathname) {
  const clean = pathname.replace(/^\/+/, '');
  if (pathname.endsWith('/')) return [`/__sitedrift_source/${clean}index.html.txt`];
  if (pathname.endsWith('.html')) return [`/__sitedrift_source/${clean}.txt`];
  return [`/__sitedrift_source/${clean}.html.txt`, `/__sitedrift_source/${clean}/index.html.txt`];
}

/**
 * @param {AssetsBinding} assets
 * @param {URL} routeUrl
 * @param {Headers} headers
 * @returns {Promise<Response>}
 */
async function devResponse(assets, routeUrl, headers) {
  for (const candidate of sourceCandidates(routeUrl.pathname)) {
    const response = await assets.fetch(new URL(candidate, routeUrl));
    if (!response.ok) continue;
    const sourceHeaders = new Headers(response.headers);
    sourceHeaders.set('content-type', 'text/html; charset=utf-8');
    return new Response(response.body, { status: 200, headers: sourceHeaders });
  }
  const response = await assets.fetch(new Request(routeUrl, { headers, redirect: 'manual' }));
  if (!/text\/html/i.test(response.headers.get('content-type') || '')) return response;
  // A missing route can fall back to a wrapped page (single-page fallback).
  // Never nest the viewer inside itself.
  const body = await response.text();
  if (body.includes(VIEWER_MARKER)) return notFound();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Builds the hosted preview handler. The defaults are the safe ones: only
 * content-negotiation headers reach production, no cookies pass in either
 * direction, the production host answers 404, and the static security
 * headers are restored on every proxied response.
 * @param {PreviewHandlerOptions} [options]
 */
export function createPreviewHandler(options = {}) {
  const forward = options.forwardHeaders ?? DEFAULT_FORWARD_HEADERS;
  const security = options.securityHeaders === false
    ? {}
    : { ...DEFAULT_SECURITY_HEADERS, ...(options.securityHeaders || {}) };

  /**
   * @param {Request} request
   * @param {PreviewEnv} env
   * @returns {Promise<Response>}
   */
  async function handle(request, env) {
    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith('/__sitedrift/')) return env.ASSETS.fetch(request);
    const match = requestUrl.pathname.match(/^\/__sitedrift\/(dev|live)(\/.*)?$/);
    if (match && !['GET', 'HEAD'].includes(request.method)) {
      return new Response('sitedrift preview proxies are read-only.', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const config = await readConfig(env.ASSETS, requestUrl);
    if (!config) return notFound();
    const liveBase = new URL(options.live || config.live);
    const productionHosts = [...hostVariants(liveBase.host), ...(options.productionHosts || [])];
    if (productionHosts.includes(requestUrl.host)) return notFound();
    const branch = env.CF_PAGES_BRANCH || env.WORKERS_CI_BRANCH;
    if (branch && branch === (options.productionBranch || config.productionBranch || 'main')) return notFound();

    if (!match) return env.ASSETS.fetch(request);

    const side = match[1] === 'live' ? 'live' : 'dev';
    const prefix = `/__sitedrift/${side}`;
    const route = `${match[2] || '/'}${requestUrl.search}`;
    const headers = pickHeaders((name) => request.headers.get(name), forward);
    let upstream;
    let upstreamUrl;
    try {
      if (side === 'dev') {
        upstreamUrl = new URL(route, requestUrl);
        upstream = await devResponse(env.ASSETS, upstreamUrl, headers);
      } else {
        upstreamUrl = new URL(route, `${liveBase.href.replace(/\/$/, '')}/`);
        if (upstreamUrl.origin !== liveBase.origin) return new Response('Invalid live target.', { status: 400 });
        upstream = await fetch(upstreamUrl, { method: request.method, headers, redirect: 'manual' });
      }
    } catch (error) {
      return new Response(`sitedrift: ${error instanceof Error ? error.message : String(error)}`, { status: 502 });
    }

    const responseHeaders = cleanResponseHeaders(upstream.headers, upstreamUrl.pathname);
    for (const [name, value] of Object.entries(security)) responseHeaders.set(name, value);
    const init = { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders };

    const location = upstream.headers.get('location');
    if (location) {
      const mapped = proxiedLocation(location, upstreamUrl, prefix);
      if (mapped) {
        responseHeaders.set('location', mapped);
      } else {
        responseHeaders.delete('location');
        responseHeaders.set('content-type', 'text/plain; charset=utf-8');
        const target = new URL(location, upstreamUrl).href;
        const message = `sitedrift: ${side.toUpperCase()} redirected to ${target}, outside ${upstreamUrl.origin}. Set --live to the final origin.`;
        return new Response(request.method === 'HEAD' ? null : message, init);
      }
    }

    const type = upstream.headers.get('content-type') || '';
    if (request.method === 'HEAD' || !/text\/html|text\/css|javascript/i.test(type)) {
      return new Response(request.method === 'HEAD' ? null : upstream.body, init);
    }
    let body = rewriteRootPaths(await upstream.text(), prefix, { script: /javascript/i.test(type) });
    if (/text\/html/i.test(type)) {
      const nonce = checkNonce(typeof options.nonce === 'function' ? options.nonce(request) : options.nonce ?? config.nonce);
      body = injectBridge(restampNonces(body, nonce), bridgeTag({ src: BRIDGE_SRC, side, prefix, nonce }));
    }
    return new Response(body, init);
  }

  return {
    /** Pages Functions entry. @param {PagesContext} context */
    onRequest: (/** @type {PagesContext} */ context) => handle(context.request, context.env),
    /** Workers entry. */
    fetch: (/** @type {Request} */ request, /** @type {PreviewEnv} */ env) => handle(request, env),
  };
}

const defaultHandler = createPreviewHandler();

/** Pages Functions entry with the default options. */
export const onRequest = defaultHandler.onRequest;

/** Workers entry with the default options. */
export default { fetch: defaultHandler.fetch };
