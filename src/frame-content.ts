// Content rewriting shared by the local proxy and the Cloudflare runtime. No
// Node imports: this file is bundled into Pages Functions and Workers.

import type { Side } from './wire.ts';

export type { Side };

/** Present in every page the viewer wraps, so a wrapped page is never wrapped (or framed) again. */
export const VIEWER_MARKER = 'id="sitedrift-config"';

const NONCE = /^[A-Za-z0-9+/=_-]{1,200}$/;

/** Validates a CSP nonce (or a build-time placeholder) for use in an attribute. */
export function checkNonce(nonce: string | undefined | null): string {
  if (nonce === undefined || nonce === null || nonce === '') return '';
  if (!NONCE.test(nonce)) throw new Error('nonce may contain only base64 or base64url characters.');
  return nonce;
}

const CHARSET = /;\s*charset\s*=\s*"?([^";\s]+)"?/i;

/** Decodes bytes with the charset a content-type declares, falling back to UTF-8 when it is missing or unknown. */
export function decodeBytes(bytes: ArrayBuffer, contentType: string | null): string {
  const label = CHARSET.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** Declares UTF-8 on a content-type whose body was decoded and is sent re-encoded as UTF-8. */
export function utf8ContentType(contentType: string): string {
  return CHARSET.test(contentType) ? contentType.replace(CHARSET, '; charset=utf-8') : contentType;
}

const nonceAttr = (nonce: string): string => (nonce ? ` nonce="${nonce}"` : '');

/** The external bridge script tag for a framed page. */
export function bridgeTag({ src, side, prefix, nonce = '' }: {
  src: string;
  side: Side;
  prefix: string;
  nonce?: string;
}): string {
  return `<script src="${src}" data-side="${side}" data-prefix="${prefix}"${nonceAttr(checkNonce(nonce))}></script>`;
}

/** Inserts the bridge before </head>, or at the start when there is no head. */
export function injectBridge(html: string, tag: string): string {
  const head = html.search(/<\/head>/i);
  return head === -1 ? `${tag}${html}` : `${html.slice(0, head)}${tag}${html.slice(head)}`;
}

/**
 * Rewrites the nonce on every script and style tag that already carries one.
 * Tags without a nonce stay without one, so only what the page's own build
 * trusted becomes trusted under the preview's policy.
 */
export function restampNonces(html: string, nonce: string): string {
  const value = checkNonce(nonce);
  if (!value) return html;
  return html.replace(
    /<(script|style)\b([^>]*?)\snonce=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    (_match: string, tag: string, attrs: string) => `<${tag}${attrs} nonce="${value}"`,
  );
}

/**
 * Prefixes root-relative URLs so a proxied page keeps loading from its side.
 * @param prefix e.g. "/__live" or "/__sitedrift/live"
 * @param options.script the body is JavaScript
 */
export function rewriteRootPaths(body: string, prefix: string, { script = false }: { script?: boolean } = {}): string {
  let out = body
    .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/)/gi, `$1${prefix}/`)
    .replace(/\bsrcset=(["'])(.*?)\1/gi, (_match: string, quote: string, value: string) => {
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
