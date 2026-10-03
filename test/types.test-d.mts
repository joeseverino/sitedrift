// Type test: the published declarations match the implementation and support
// the documented adopter code. Checked by `npm run typecheck`, never executed.
import * as declaredRuntime from 'sitedrift/cloudflare';
import worker, { createPreviewHandler, onRequest } from 'sitedrift/cloudflare';
import * as declaredNode from 'sitedrift';
import * as runtime from '../src/cloudflare-runtime.mjs';
import * as node from '../src/index.mjs';

export const runtimeMatches: Omit<typeof declaredRuntime, 'default'> = runtime;
export const workerMatches: typeof worker = runtime.default;
export const nodeMatches: typeof declaredNode = node;

// Pages Function
export const pages: typeof onRequest = createPreviewHandler({
  nonce: '__CSP_NONCE__',
  forwardHeaders: ['accept', 'cache-control'],
  securityHeaders: { 'x-frame-options': 'SAMEORIGIN' },
}).onRequest;

// Worker
export default { fetch: createPreviewHandler().fetch } satisfies typeof worker;

// @ts-expect-error securityHeaders takes a record or false
createPreviewHandler({ securityHeaders: true });
