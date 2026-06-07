import { frameBridge, rewriteRootPaths } from './frame-content.mjs';

const STRIP_HEADERS = [
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'transfer-encoding',
  'x-frame-options',
];

function cleanHeaders(source) {
  const headers = new Headers(source);
  for (const name of STRIP_HEADERS) headers.delete(name);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow');
  return headers;
}

async function configFor(context) {
  const url = new URL('/__sitedrift/config.json', context.request.url);
  const response = await context.env.ASSETS.fetch(url);
  if (!response.ok) throw new Error('sitedrift preview config is unavailable');
  return response.json();
}

async function devResponse(context, route) {
  const requestUrl = new URL(context.request.url);
  const routeUrl = new URL(route, requestUrl);
  const pathname = routeUrl.pathname;
  const accept = context.request.headers.get('accept') || '';
  if (context.request.method === 'GET' && accept.includes('text/html')) {
    const clean = pathname.replace(/^\/+/, '');
    const candidates = pathname.endsWith('/')
      ? [`/__sitedrift/source/${clean}index.html.txt`]
      : [`/__sitedrift/source/${clean}.html.txt`, `/__sitedrift/source/${clean}/index.html.txt`];
    if (pathname === '/') candidates.unshift('/__sitedrift/source/index.html.txt');
    for (const pathname of candidates) {
      const response = await context.env.ASSETS.fetch(new URL(pathname, requestUrl));
      if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }
  }
  return context.env.ASSETS.fetch(routeUrl);
}

async function liveResponse(context, route, live) {
  const base = new URL(live);
  const target = new URL(route, `${base.href.replace(/\/$/, '')}/`);
  if (target.origin !== base.origin) return new Response('Invalid live target.', { status: 400 });
  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.delete('accept-encoding');
  const init = {
    method: context.request.method,
    headers,
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(context.request.method)) init.body = context.request.body;
  return fetch(target, init);
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  if (requestUrl.pathname.startsWith('/__sitedrift/source')) {
    return new Response('Not found.', { status: 404 });
  }
  const match = requestUrl.pathname.match(/^\/__sitedrift\/(dev|live)(\/.*)?$/);
  if (!match) return context.env.ASSETS.fetch(context.request);
  if (!['GET', 'HEAD'].includes(context.request.method)) {
    return new Response('sitedrift preview proxies are read-only.', {
      status: 405,
      headers: { allow: 'GET, HEAD' },
    });
  }

  const side = match[1];
  const route = `${match[2] || '/'}${requestUrl.search}`;
  let upstream;
  try {
    const config = await configFor(context);
    upstream = side === 'dev'
      ? await devResponse(context, route)
      : await liveResponse(context, route, config.live);
  } catch (error) {
    return new Response(`sitedrift: ${error.message}`, { status: 502 });
  }

  const headers = cleanHeaders(upstream.headers);
  const location = upstream.headers.get('location');
  if (location) {
    const config = await configFor(context);
    const base = side === 'live' ? new URL(config.live) : requestUrl;
    const redirected = new URL(location, base);
    if (side === 'dev' || redirected.origin === base.origin) {
      headers.set('location', `/__sitedrift/${side}${redirected.pathname}${redirected.search}${redirected.hash}`);
    }
  }

  const type = upstream.headers.get('content-type') || '';
  const rewritable = /text\/html|text\/css|javascript/.test(type);
  if (rewritable && context.request.method !== 'HEAD') {
    let body = rewriteRootPaths(await upstream.text(), `/__sitedrift/${side}`);
    if (/text\/html/.test(type)) {
      const bridge = frameBridge(side, `/__sitedrift/${side}`);
      body = body.includes('</head>') ? body.replace('</head>', `${bridge}</head>`) : `${bridge}${body}`;
    }
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  return new Response(context.request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
