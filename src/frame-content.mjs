// Content rewriting shared by the local proxy and the Cloudflare runtime. No
// Node imports: this file is bundled into Pages Functions and Workers.

const NONCE = /^[A-Za-z0-9+/=_-]{1,200}$/;

/**
 * Validates a CSP nonce (or a build-time placeholder) for use in an attribute.
 * @param {string | undefined | null} nonce
 * @returns {string}
 */
export function checkNonce(nonce) {
  if (nonce === undefined || nonce === null || nonce === '') return '';
  if (!NONCE.test(nonce)) throw new Error('nonce may contain only base64 or base64url characters.');
  return nonce;
}

/** @param {string} nonce */
const nonceAttr = (nonce) => (nonce ? ` nonce="${nonce}"` : '');

/**
 * The external bridge script tag for a framed page.
 * @param {{ src: string, side: 'dev' | 'live', prefix: string, nonce?: string }} options
 */
export function bridgeTag({ src, side, prefix, nonce = '' }) {
  return `<script src="${src}" data-side="${side}" data-prefix="${prefix}"${nonceAttr(checkNonce(nonce))}></script>`;
}

/**
 * Inserts the bridge before </head>, or at the start when there is no head.
 * @param {string} html
 * @param {string} tag
 */
export function injectBridge(html, tag) {
  const head = html.search(/<\/head>/i);
  return head === -1 ? `${tag}${html}` : `${html.slice(0, head)}${tag}${html.slice(head)}`;
}

/**
 * Rewrites the nonce on every script and style tag that already carries one.
 * Tags without a nonce stay without one, so only what the page's own build
 * trusted becomes trusted under the preview's policy.
 * @param {string} html
 * @param {string} nonce
 */
export function restampNonces(html, nonce) {
  const value = checkNonce(nonce);
  if (!value) return html;
  return html.replace(
    /<(script|style)\b([^>]*?)\snonce=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    (_, tag, attrs) => `<${tag}${attrs} nonce="${value}"`,
  );
}

/**
 * Prefixes root-relative URLs so a proxied page keeps loading from its side.
 * @param {string} body
 * @param {string} prefix e.g. "/__live" or "/__sitedrift/live"
 * @param {{ script?: boolean }} [options] script: the body is JavaScript
 */
export function rewriteRootPaths(body, prefix, { script = false } = {}) {
  let out = body
    .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}/`)
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (_, quote, value) => {
      const rewritten = value.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`);
      return `srcset=${quote}${rewritten}${quote}`;
    })
    .replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}/`)
    .replace(/(["'`])\/(@(?:id|vite|fs)\/|_astro\/)/g, `$1${prefix}/$2`);
  // Vite's preload helper joins base "/" with base-relative deps such as
  // "_astro/chunk.js"; prefix those so dynamic imports stay on this side.
  if (script) out = out.replace(/(["'`])_astro\//g, `$1${prefix.replace(/^\//, '')}/_astro/`);
  return out;
}
