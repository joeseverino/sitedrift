// Header policy shared by the local proxy and the Cloudflare runtime. No Node
// imports: this file is bundled into Pages Functions and Workers.

/** Request headers a LIVE (production) upstream may see. Nothing else is sent. */
export const DEFAULT_FORWARD_HEADERS = Object.freeze([
  'accept',
  'accept-language',
  'user-agent',
  'if-none-match',
  'if-modified-since',
  'range',
]);

/** Upstream response headers removed so both sides can render framed. */
export const STRIP_RESPONSE_HEADERS = Object.freeze([
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'set-cookie',
  'transfer-encoding',
  'x-frame-options',
]);

/**
 * Static security headers the hosted handler puts back on proxied responses.
 * The frame is same-origin with the viewer, so SAMEORIGIN still allows it.
 */
export const DEFAULT_SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

/**
 * Copies only the allowlisted request headers.
 * @param {(name: string) => string | null | undefined} get
 * @param {readonly string[]} [names]
 * @returns {Headers}
 */
export function pickHeaders(get, names = DEFAULT_FORWARD_HEADERS) {
  const headers = new Headers();
  for (const name of names) {
    const value = get(name.toLowerCase());
    if (value !== null && value !== undefined && value !== '') headers.set(name, value);
  }
  return headers;
}

/**
 * True for content-hashed build assets that are safe to cache.
 * @param {string} pathname
 * @param {string | null} cacheControl
 */
export function isImmutableAsset(pathname, cacheControl) {
  return /\/_astro\//.test(pathname) || /\bimmutable\b/i.test(cacheControl || '');
}

/**
 * Upstream response headers with framing, isolation, and cookie headers removed.
 * Pages are no-store; hashed assets keep the upstream cache policy.
 * @param {Headers} source
 * @param {string} pathname upstream path, used for the cache decision
 * @returns {Headers}
 */
export function cleanResponseHeaders(source, pathname) {
  const headers = new Headers(source);
  for (const name of STRIP_RESPONSE_HEADERS) headers.delete(name);
  if (!isImmutableAsset(pathname, source.get('cache-control'))) headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow');
  return headers;
}

/**
 * Maps an upstream redirect back under the proxy prefix. Returns null when the
 * redirect leaves the upstream origin.
 * @param {string} location
 * @param {URL} upstream the URL that was fetched
 * @param {string} prefix e.g. "/__sitedrift/live"
 * @returns {string | null}
 */
export function proxiedLocation(location, upstream, prefix) {
  const redirected = new URL(location, upstream);
  if (redirected.origin !== upstream.origin) return null;
  return `${prefix}${redirected.pathname}${redirected.search}${redirected.hash}`;
}
