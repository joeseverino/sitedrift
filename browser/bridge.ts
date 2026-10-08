// sitedrift frame bridge. Loaded into each framed page as an external script
// (data-side, data-prefix) so it runs under a nonce or self-only CSP. Reports
// route, metadata, timing, and scroll to the viewer; applies scroll and settings
// from it. No HTML sinks.
(() => {
  type Side = import('../src/wire.ts').Side;
  type FrameMessage = import('../src/wire.ts').FrameMessage;
  type ParentMessage = import('../src/wire.ts').ParentMessage;
  type SeoCheck = import('../src/wire.ts').SeoCheck;

  const script = document.currentScript;
  const declaredSide = script?.dataset.side;
  const prefix = script?.dataset.prefix || '';
  if (declaredSide !== 'dev' && declaredSide !== 'live') return;
  const side: Side = declaredSide;

  let linked = false;
  let mirror = false;
  let stacked = false;

  const send = (message: FrameMessage): void => {
    parent.postMessage({ source: 'sitedrift-frame', side, ...message }, '*');
  };
  const root = (): Element => document.scrollingElement || document.documentElement;
  const maxScroll = (): number => Math.max(0, root().scrollHeight - innerHeight);
  const route = (): string => location.pathname.replace(prefix, '') + location.search + location.hash || '/';
  const check = (label: string, ok: boolean, note?: string): SeoCheck => ({ label, ok, note });

  const snapshot = (): void => {
    const q = <T extends Element = Element>(selector: string): T | null => document.querySelector<T>(selector);
    const imgs = [...document.querySelectorAll('img')];
    const title = (document.title || '').trim();
    const description = q<HTMLMetaElement>('meta[name="description"]')?.content.trim() || '';
    const canonical = q<HTMLLinkElement>('link[rel="canonical"]')?.href || '';
    const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const icon = (icons.find((item) => (item.type || '').toLowerCase() === 'image/svg+xml' || /\.svg(?:$|[?#])/i.test(item.href)) || icons[0])?.href || '';
    const navigation = performance.getEntriesByType('navigation').find(
      (entry): entry is PerformanceNavigationTiming => entry.entryType === 'navigation',
    );
    const timing = navigation ? {
      response: Math.round(navigation.responseEnd),
      dom: Math.round(navigation.domContentLoadedEventEnd),
      load: Math.round(navigation.loadEventEnd || navigation.duration),
      transfer: Number(navigation.transferSize) || 0,
      decoded: Number(navigation.decodedBodySize) || 0,
    } : null;
    const h1Count = document.querySelectorAll('h1').length;
    const checks = [
      check('Title present', !!title),
      check('Title 30–60 chars', title.length >= 30 && title.length <= 60, String(title.length)),
      check('Meta description', !!description),
      check('Description 70–160', description.length >= 70 && description.length <= 160, String(description.length)),
      check('Exactly one H1', h1Count === 1, `${h1Count} found`),
      check('Canonical link', !!q('link[rel="canonical"]')),
      check('Viewport meta', !!q('meta[name="viewport"]')),
      check('html lang', !!document.documentElement.lang),
      check('Open Graph title', !!q('meta[property="og:title"]')),
      check('Open Graph image', !!q('meta[property="og:image"]')),
      check('Not noindex', !(q<HTMLMetaElement>('meta[name="robots"]')?.content || '').toLowerCase().includes('noindex')),
      check('Favicon', !!icon),
      check('Images have alt', imgs.every((img) => img.hasAttribute('alt')), `${imgs.filter((img) => !img.hasAttribute('alt')).length} missing`),
    ];
    send({
      type: 'ready',
      route: route(),
      meta: {
        title,
        description,
        canonical,
        heading: q('h1')?.textContent?.trim() || '',
        siteName: q<HTMLMetaElement>('meta[property="og:site_name"]')?.content.trim() || '',
        icon,
        checks,
        timing,
      },
    });
    send({ type: 'scroll', y: scrollY, max: maxScroll() });
  };

  const isParentMessage = (data: unknown): data is ParentMessage & { source: string; side: string } =>
    typeof data === 'object' && data !== null
    && 'source' in data && data.source === 'sitedrift-parent'
    && 'side' in data && data.side === side
    && 'type' in data && typeof data.type === 'string';

  addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data;
    if (!isParentMessage(msg)) return;
    if (msg.type === 'settings') {
      linked = !!msg.linked;
      mirror = !!msg.mirror;
      stacked = !!msg.stacked;
      document.documentElement.style.scrollBehavior = 'auto';
    }
    if (msg.type === 'scroll') root().scrollTop = msg.y;
    if (msg.type === 'reload') location.reload();
  });
  addEventListener('scroll', () => send({ type: 'scroll', y: scrollY, max: maxScroll() }), { passive: true });
  // Only hijack the wheel when the panes are stacked (Overlay), where pixel-exact
  // lockstep is required and there is no per-pane native scroll to mirror. Side-by-side
  // views scroll natively (preserving momentum) and mirror via the scroll listener.
  addEventListener('wheel', (event) => {
    if (!linked || !stacked || !event.deltaY) return;
    event.preventDefault();
    send({ type: 'wheel', delta: event.deltaY, mode: event.deltaMode, height: innerHeight, y: scrollY });
  }, { passive: false, capture: true });
  addEventListener('keydown', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    const plain = !typing && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (plain && ['r', 's', '0', '/', 'o', 'd'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      send({ type: 'key', key: event.key.toLowerCase() });
      return;
    }
    if (linked && plain) {
      send({ type: 'key', key: event.key, shift: event.shiftKey, y: scrollY, height: innerHeight, max: maxScroll() });
    }
  }, true);
  addEventListener('click', (event) => {
    send({ type: 'dismiss' });
    if (!mirror || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) return;
    event.preventDefault();
    send({ type: 'navigate', route: url.pathname.slice(prefix.length) || '/' });
  }, true);
  addEventListener('DOMContentLoaded', snapshot, { once: true });
  if (document.readyState !== 'loading') snapshot();
})();
