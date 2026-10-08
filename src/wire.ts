// Types shared by the Node side and the two browser scripts (the viewer and the
// frame bridge). Type-only: nothing here exists at runtime.

export type Side = 'dev' | 'live';

export interface Note {
  id: string;
  text: string;
  author: string;
  route: string;
  side: Side | null;
  done: boolean;
  ts: number;
}

/** The inert JSON blob the server writes into the viewer page. */
export interface ViewerConfig {
  dev: string;
  live: string;
  brand: string;
  author: string;
  vault: boolean;
  token: string;
  api: string;
  frameOrigins: Record<Side, string>;
  hosted: boolean;
  localNotes?: boolean;
  initialPath?: string;
}

export interface SeoCheck {
  label: string;
  ok: boolean;
  note?: string;
}

export interface NavigationTiming {
  response: number;
  dom: number;
  load: number;
  transfer: number;
  decoded: number;
}

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  heading: string;
  siteName: string;
  icon: string;
  checks: SeoCheck[];
  timing: NavigationTiming | null;
}

/** Messages the bridge posts from a framed page up to the viewer. */
export type FrameMessage =
  | { type: 'ready'; route: string; meta: PageMeta }
  | { type: 'scroll'; y: number; max: number }
  | { type: 'wheel'; delta: number; mode: number; height: number; y: number }
  | { type: 'key'; key: string; shift?: boolean; y?: number; height?: number; max?: number }
  | { type: 'navigate'; route: string }
  | { type: 'dismiss' };

/** Messages the viewer posts down to a framed page's bridge. */
export type ParentMessage =
  | { type: 'settings'; linked: boolean; mirror: boolean; stacked: boolean }
  | { type: 'scroll'; y: number }
  | { type: 'reload' };
