export interface InstallOptions {
  /** Build output directory. Auto-detected (dist, _site, build, public, out, ...) when omitted. */
  dir?: string;
  /** Production origin. HTTPS, or a loopback origin for testing. */
  live: string;
  /** Strip "| <brand>" from page titles in the viewer. */
  brand?: string;
  /** Branch whose builds are left untouched. Default "main". */
  productionBranch?: string;
  /** CSP nonce or placeholder stamped on every tag sitedrift writes. */
  nonce?: string;
  /** Build environment. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Wrap even outside a Cloudflare preview build. */
  force?: boolean;
}

export type InstallResult =
  | { installed: true; branch: string; files: number }
  | { installed: false; reason: string };

export function installCloudflarePreview(options: InstallOptions): InstallResult;

export function scaffoldCloudflarePreview(options?: {
  cwd?: string;
  js?: boolean;
  live?: string;
  dir?: string;
}): { created: boolean; functionFile: string; outDir: string; buildLine: string };

export function detectBuild(env: Record<string, string | undefined>): {
  platform: 'pages' | 'workers' | '';
  branch: string;
};

/** Reads sitedrift.config.json, .sitedriftrc.json, or package.json "sitedrift". */
export function readProjectConfig(options?: { explicit?: string; cwd?: string }): Record<string, unknown>;
