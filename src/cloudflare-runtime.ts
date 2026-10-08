// Edge runtime for hosted previews: Cloudflare Pages Functions and Workers
// with static assets. Serves /__sitedrift/dev/* from the preview's own build
// and /__sitedrift/live/* from the one configured production origin.

import { VIEWER_MARKER, bridgeTag, checkNonce, decodeBytes, injectBridge, restampNonces, rewriteRootPaths, utf8ContentType } from './frame-content.ts';
import type { Side } from './frame-content.ts';
import {
  DEFAULT_FORWARD_HEADERS,
  DEFAULT_SECURITY_HEADERS,
  cleanResponseHeaders,
  pickHeaders,
  proxiedLocation,
} from './headers.ts';

export { DEFAULT_FORWARD_HEADERS, DEFAULT_SECURITY_HEADERS };

const BRIDGE_SRC = '/__sitedrift/assets/bridge.js';

/** Static assets binding: Pages `env.ASSETS` or a Workers assets binding named ASSETS. */
export interface AssetsBinding {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

export interface PreviewEnv {
  ASSETS: AssetsBinding;
  [key: string]: unknown;
}

export interface PagesContext {
  request: Request;
  env: PreviewEnv;
}

export interface PreviewHandlerOptions {
  /** Production origin. Defaults to the `live` written at build time. */
  live?: string;
  /** Requests on this branch answer 404 when the runtime exposes the branch. Default "main". */
  productionBranch?: string;
  /** Extra hosts that must never serve the review proxy. The live host and its www variant always answer 404. */
  productionHosts?: string[];
  /**
   * CSP nonce (or build-time placeholder) stamped on the injected bridge and
   * on every already-nonced script and style tag in framed pages. Defaults to
   * the `--nonce` written at build time.
   */
  nonce?: string | ((request: Request) => string | undefined);
  /** Request headers forwarded upstream. Default: {@link DEFAULT_FORWARD_HEADERS}. */
  forwardHeaders?: readonly string[];
  /** Headers set on proxied responses, merged over the defaults. `false` sets none. */
  securityHeaders?: Record<string, string> | false;
}

export interface PreviewHandler {
  /** Pages Functions entry. */
  onRequest(context: PagesContext): Promise<Response>;
  /** Workers entry. */
  fetch(request: Request, env: PreviewEnv): Promise<Response>;
}

interface PreviewConfig {
  live: string;
  nonce?: string;
  productionBranch?: string;
}

const notFound = (): Response => new Response('Not found.', {
  status: 404,
  headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
});

function hostVariants(host: string): string[] {
  const bare = host.replace(/^www\./, '');
  return [bare, `www.${bare}`];
}

async function readConfig(assets: AssetsBinding, requestUrl: URL): Promise<PreviewConfig | null> {
  const response = await assets.fetch(new URL('/__sitedrift/config.json', requestUrl));
  if (!response.ok) return null;
  try {
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || !('live' in value) || typeof value.live !== 'string') return null;
    const config: PreviewConfig = { live: value.live };
    if ('nonce' in value && typeof value.nonce === 'string') config.nonce = value.nonce;
    if ('productionBranch' in value && typeof value.productionBranch === 'string') config.productionBranch = value.productionBranch;
    return config;
  } catch {
    return null;
  }
}

/** Source-copy paths tried for a DEV route, in order. Every wrapped page keeps its original under /__sitedrift_source/<file>.html.txt. */
export function sourceCandidates(pathname: string): string[] {
  const clean = pathname.replace(/^\/+/, '');
  if (pathname.endsWith('/')) return [`/__sitedrift_source/${clean}index.html.txt`];
  if (pathname.endsWith('.html')) return [`/__sitedrift_source/${clean}.txt`];
  return [`/__sitedrift_source/${clean}.html.txt`, `/__sitedrift_source/${clean}/index.html.txt`];
}

async function devResponse(assets: AssetsBinding, routeUrl: URL, headers: Headers): Promise<Response> {
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
  const bytes = await response.arrayBuffer();
  if (decodeBytes(bytes, response.headers.get('content-type')).includes(VIEWER_MARKER)) return notFound();
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function currentBranch(env: PreviewEnv): string {
  for (const value of [env['CF_PAGES_BRANCH'], env['WORKERS_CI_BRANCH']]) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * Builds the hosted preview handler. The defaults are the safe ones: only
 * content-negotiation headers reach production, no cookies pass in either
 * direction, the production host answers 404, and the static security
 * headers are restored on every proxied response.
 */
export function createPreviewHandler(options: PreviewHandlerOptions = {}): PreviewHandler {
  const forward = options.forwardHeaders ?? DEFAULT_FORWARD_HEADERS;
  const security = options.securityHeaders === false
    ? {}
    : { ...DEFAULT_SECURITY_HEADERS, ...options.securityHeaders };

  async function handle(request: Request, env: PreviewEnv): Promise<Response> {
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
    const branch = currentBranch(env);
    if (branch && branch === (options.productionBranch || config.productionBranch || 'main')) return notFound();

    if (!match) return env.ASSETS.fetch(request);

    const side: Side = match[1] === 'live' ? 'live' : 'dev';
    const prefix = `/__sitedrift/${side}`;
    const route = `${match[2] || '/'}${requestUrl.search}`;
    const headers = pickHeaders((name) => request.headers.get(name), forward);
    let upstream: Response;
    let upstreamUrl: URL;
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
    let body = rewriteRootPaths(decodeBytes(await upstream.arrayBuffer(), type), prefix, { script: /javascript/i.test(type) });
    if (/text\/html/i.test(type)) {
      const nonce = checkNonce(typeof options.nonce === 'function' ? options.nonce(request) : options.nonce ?? config.nonce);
      body = injectBridge(restampNonces(body, nonce), bridgeTag({ src: BRIDGE_SRC, side, prefix, nonce }));
    }
    responseHeaders.set('content-type', utf8ContentType(type));
    return new Response(body, init);
  }

  return {
    onRequest: (context) => handle(context.request, context.env),
    fetch: (request, env) => handle(request, env),
  };
}

const defaultHandler = createPreviewHandler();

/** Pages Functions entry with the default options. */
export const onRequest: (context: PagesContext) => Promise<Response> = defaultHandler.onRequest;

/** Workers entry with the default options. */
const worker: { fetch(request: Request, env: PreviewEnv): Promise<Response> } = { fetch: defaultHandler.fetch };
export default worker;
