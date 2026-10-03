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

/** accept, accept-language, user-agent, if-none-match, if-modified-since, range. */
export const DEFAULT_FORWARD_HEADERS: readonly string[];
export const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>>;

export function createPreviewHandler(options?: PreviewHandlerOptions): PreviewHandler;

/** Source-copy paths tried for a DEV route, in order. */
export function sourceCandidates(pathname: string): string[];

/** Pages Functions entry with the default options. */
export const onRequest: (context: PagesContext) => Promise<Response>;

/** Workers entry with the default options. */
declare const worker: { fetch(request: Request, env: PreviewEnv): Promise<Response> };
export default worker;
