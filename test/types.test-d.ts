// Type test: the documented adopter code compiles against the public entry
// points. Checked by `npm run check:types`, never executed. The packed package
// is checked the same way against its emitted declarations (see README).
import worker, { createPreviewHandler, onRequest } from '../src/cloudflare-runtime.ts';
import type { PagesContext, PreviewEnv, PreviewHandlerOptions } from '../src/cloudflare-runtime.ts';
import { installCloudflarePreview, readProjectConfig } from '../src/index.ts';
import type { InstallOptions, InstallResult } from '../src/index.ts';

// Pages Function
export const pages: typeof onRequest = createPreviewHandler({
  nonce: '__CSP_NONCE__',
  forwardHeaders: ['accept', 'cache-control'],
  securityHeaders: { 'x-frame-options': 'SAMEORIGIN' },
}).onRequest;

// Worker
export default { fetch: createPreviewHandler().fetch } satisfies typeof worker;

// Per-request nonce
export const options: PreviewHandlerOptions = { nonce: (request) => request.headers.get('x-nonce') ?? undefined };

export const wrap = (install: InstallOptions): InstallResult => installCloudflarePreview(install);
export const config: Record<string, unknown> = readProjectConfig({ cwd: '.' });
export const run = (context: PagesContext, env: PreviewEnv): Promise<Response> => onRequest({ ...context, env });

// @ts-expect-error securityHeaders takes a record or false
createPreviewHandler({ securityHeaders: true });

// @ts-expect-error a build needs the production origin
installCloudflarePreview({ dir: 'dist' });
