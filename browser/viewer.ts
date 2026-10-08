// sitedrift viewer. Served as a classic external script (/viewer.js) so it runs
// under a nonce or self-only CSP. Reads its configuration from the inert JSON
// block in the page and builds all DOM with createElement and textContent, so
// there are no HTML sinks.
(() => {
  type Side = import('../src/wire.ts').Side;
  type ViewerConfig = import('../src/wire.ts').ViewerConfig;
  type FrameMessage = import('../src/wire.ts').FrameMessage;
  type ParentMessage = import('../src/wire.ts').ParentMessage;
  type PageMeta = import('../src/wire.ts').PageMeta;
  type SeoCheck = import('../src/wire.ts').SeoCheck;
  type WireNote = import('../src/wire.ts').Note;

  type ViewMode = 'split' | 'solo' | 'overlay';
  type ScrollMode = 'exact' | 'ratio';
  type Blend = 'opacity' | 'difference';

  /** A note as the viewer holds it: from the server, or from this browser's storage in hosted previews. */
  type ViewerNote = Omit<WireNote, 'ts'> & { ts?: number; createdAt?: string };
  type NoteRequest =
    | { op: 'add'; text: string; author: string; route: string; side: Side | null }
    | { op: 'toggle' | 'remove'; id: string };

  interface StatusDetail {
    status?: number;
    requestMs?: number;
    type?: string;
    cache?: string;
    response?: number;
    dom?: number;
    load?: number;
    transfer?: number;
    decoded?: number;
  }
  type MetricKey = 'status' | 'response' | 'dom' | 'load' | 'size';

  interface MetaSummary {
    title: string;
    description: string;
    canonicalPath: string;
    heading: string;
  }

  type KeyMessage = Extract<FrameMessage, { type: 'key' }>;
  type ReadyMessage = Extract<FrameMessage, { type: 'ready' }>;

  const SIDES: readonly Side[] = ['dev', 'live'];
  const otherOf = (side: Side): Side => (side === 'dev' ? 'live' : 'dev');

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number => Number(value) || 0;

  function readConfig(): ViewerConfig {
    const raw: unknown = JSON.parse(document.getElementById('sitedrift-config')?.textContent || '{}');
    const value = isRecord(raw) ? raw : {};
    const origins = isRecord(value.frameOrigins) ? value.frameOrigins : {};
    const result: ViewerConfig = {
      dev: str(value.dev),
      live: str(value.live),
      brand: str(value.brand),
      author: str(value.author),
      vault: value.vault === true,
      token: str(value.token),
      api: str(value.api),
      frameOrigins: { dev: str(origins.dev), live: str(origins.live) },
      hosted: value.hosted === true,
      localNotes: value.localNotes === true,
    };
    if (typeof value.initialPath === 'string') result.initialPath = value.initialPath;
    return result;
  }

  function must<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document): T {
    const found = scope.querySelector<T>(selector);
    if (!found) throw new Error(`sitedrift viewer: missing ${selector}`);
    return found;
  }

  // Browsers can refuse storage outright (blocked site data, some sandboxes);
  // the viewer then runs with its defaults instead of failing to start.
  const storage = {
    get(key: string): string | null {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key: string, value: string): void {
      try { localStorage.setItem(key, value); } catch { /* not persisted */ }
    },
  };

  const config = readConfig();
  if (config.hosted) {
    config.dev = location.origin;
    config.frameOrigins = { dev: location.origin, live: location.origin };
    for (const iframe of document.querySelectorAll('iframe[data-side]')) {
      // Safari requires same-origin for `style-src 'self'`; scripts are
      // required for the preview to behave like the deployed application.
      iframe.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts');
    }
  }
  const root = document.documentElement;
  const app = must('.app');
  const routeInput = must<HTMLInputElement>('.route');
  const divider = must('.divider');
  const scrollButton = must('[data-action="scroll"]');
  const scrollModeButton = must('[data-action="scroll-mode"]');
  const mirrorButton = must('[data-action="mirror"]');
  const mobileButton = must('[data-action="mobile"]');
  const modeButtons = [...document.querySelectorAll<HTMLElement>('[data-mode]')];
  const overlaySliders = [...document.querySelectorAll<HTMLInputElement>('.overlay-slider input')];
  const blendButtons = [...document.querySelectorAll<HTMLElement>('[data-action="overlay-blend"]')];
  const notesDrawer = must('.review-drawer');
  const noteList = must('.note-list');
  const noteInput = must<HTMLTextAreaElement>('.note-compose textarea');
  const toast = must('.toast');
  const statusPopover = must('.status-popover');
  const params = new URLSearchParams(location.search);
  const suppressScrollUntil: Record<Side, number> = { dev: 0, live: 0 };
  const scrollFrames: Record<Side, number> = { dev: 0, live: 0 };
  const settleTimers: Record<Side, number[]> = { dev: [], live: [] };
  const frameState: Record<Side, { y: number; max: number }> = { dev: { y: 0, max: 0 }, live: { y: 0, max: 0 } };
  const frameReady: Record<Side, boolean> = { dev: false, live: false };

  function queryOrStoredBool(queryName: string, storageName: string, fallback: boolean): boolean {
    if (params.has(queryName)) return params.get(queryName) === '1';
    const stored = storage.get(storageName);
    return stored === null ? fallback : stored === '1';
  }

  const isViewMode = (value: string | null | undefined): value is ViewMode =>
    value === 'split' || value === 'solo' || value === 'overlay';

  const order: Side[] = params.get('swap') === '1' ? ['live', 'dev'] : ['dev', 'live'];
  let syncScroll = queryOrStoredBool('scroll', 'site-compare-scroll', config.hosted);
  const requestedScrollMode = params.get('scrollMode') || storage.get('site-compare-scroll-mode');
  let scrollMode: ScrollMode = requestedScrollMode === 'ratio' ? 'ratio' : 'exact';
  let mirrorLinks = queryOrStoredBool('mirror', 'site-compare-mirror', config.hosted);
  let mobileMode = (params.get('mode') || storage.get('site-compare-mode')) === 'mobile';
  let compactMode = queryOrStoredBool('compact', 'site-compare-compact', config.hosted);
  const storedView = storage.get('site-compare-view');
  const requestedView = params.get('view')
    || (params.get('overlay') === '1' ? 'overlay' : params.get('solo') === '1' ? 'solo' : null)
    || storedView
    || (config.hosted ? 'solo' : null)
    || (innerWidth <= 600 ? 'solo' : 'split');
  let viewMode: ViewMode = isViewMode(requestedView) ? requestedView : 'split';
  let overlayBlend: Blend = (params.get('overlayBlend') || storage.get('site-compare-overlay-blend')) === 'difference' ? 'difference' : 'opacity';
  // Older links used view=diff for the overlay's difference blend.
  if (requestedView === 'diff') { viewMode = 'overlay'; overlayBlend = 'difference'; }
  let overlayAmount = Number(params.get('overlayAmount') ?? storage.get('site-compare-overlay-amount'));
  if (!Number.isFinite(overlayAmount)) overlayAmount = 50;
  let focusSide: Side = params.get('focus') === 'live' ? 'live' : 'dev';
  let reviewNotes: ViewerNote[] = [];
  let notesSignature = '';
  let notesOpen = params.get('notes') === '1';
  let dockMode = queryOrStoredBool('dock', 'site-compare-dock', true);
  let scrollOwner: Side | null = null;
  const meta: Record<Side, MetaSummary | null> = { dev: null, live: null };
  const statusDetails: Record<Side, StatusDetail> = { dev: {}, live: {} };
  const apiHeaders = {
    authorization: 'Bearer ' + config.token,
    'content-type': 'application/json',
  };
  const localNotesKey = 'sitedrift-preview-notes:' + location.host + ':' + config.live;

  function normalizeRoute(input: string): string {
    let value = input;
    try {
      if (/^https?:\/\//.test(value)) {
        const parsed = new URL(value);
        value = parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
      // Not a parseable URL: treat the text as a route.
    }
    value = value.trim() || '/';
    return value.startsWith('/') ? value : '/' + value;
  }

  function frame(side: Side): HTMLIFrameElement {
    return must<HTMLIFrameElement>('iframe[data-side="' + side + '"]');
  }
  function proxyPath(side: Side): string { return config.hosted ? '/__sitedrift/' + side : '/__' + side; }
  function httpUrl(base: string, route: string): string {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Expected an HTTP(S) origin.');
    return new URL(normalizeRoute(route), origin).href;
  }
  function proxied(side: Side, route: string): string {
    return httpUrl(config.frameOrigins[side], proxyPath(side) + normalizeRoute(route));
  }
  function statusUrl(side: Side, route: string): string { return proxyPath(side) + normalizeRoute(route); }
  function direct(side: Side, route: string): string {
    return config.hosted && side === 'dev'
      ? httpUrl(location.origin, proxyPath(side) + normalizeRoute(route))
      : httpUrl(config[side], normalizeRoute(route));
  }
  const neutralSiteIcon = 'data:image/svg+xml,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
      + '<circle cx="12" cy="12" r="10" fill="#64748b"/>'
      + '<path d="M2.8 12h18.4M12 2.8c3 3 3 15.4 0 18.4M12 2.8c-3 3-3 15.4 0 18.4" '
      + 'fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>'
      + '</svg>');
  function setFavicon(image: HTMLImageElement, side: Side, declared = ''): void {
    const base = config.frameOrigins[side] + proxyPath(side);
    const candidates = [...new Set([
      declared,
      `${base}/favicon.svg`,
      `${base}/favicon.ico`,
      neutralSiteIcon,
    ].filter(Boolean))];
    let index = 0;
    image.onerror = () => {
      index++;
      const next = candidates[index];
      if (next !== undefined) image.src = next;
      else image.onerror = null;
    };
    image.src = candidates[0] ?? neutralSiteIcon;
  }
  function framePost(side: Side, message: ParentMessage): void {
    // `iframe.src` changes before its browsing context finishes navigating,
    // so only send after the injected bridge explicitly reports readiness.
    if (!frameReady[side]) return;
    frame(side).contentWindow?.postMessage(
      { source: 'sitedrift-parent', side, ...message },
      config.hosted ? '*' : config.frameOrigins[side],
    );
  }

  function statusBadges(side: Side): HTMLElement[] {
    return [
      document.querySelector<HTMLElement>('.label[data-label="' + side + '"] .status-badge'),
      document.querySelector<HTMLElement>('[data-compact-side="' + side + '"] .status-badge'),
    ].filter((badge): badge is HTMLElement => badge !== null);
  }

  function formatMs(value: number | undefined): string {
    return value !== undefined && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '';
  }

  function formatBytes(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function statusSummary(side: Side): string {
    const detail = statusDetails[side];
    if (detail.response) return `Response ${formatMs(detail.response)}`;
    if (detail.requestMs) return `Status check ${formatMs(detail.requestMs)}`;
    return 'Click for response details';
  }

  function metricValue(side: Side, key: MetricKey): string {
    const detail = statusDetails[side];
    if (key === 'status') return detail.status ? String(detail.status) : 'ERR';
    if (key === 'size') return formatBytes(detail.transfer || detail.decoded) || '-';
    return formatMs(detail[key]) || '-';
  }

  function metricDelta(key: MetricKey): { text: string; className: string } {
    if (key === 'status') return { text: '-', className: '' };
    const dev = key === 'size'
      ? statusDetails.dev.transfer || statusDetails.dev.decoded
      : statusDetails.dev[key];
    const live = key === 'size'
      ? statusDetails.live.transfer || statusDetails.live.decoded
      : statusDetails.live[key];
    if (dev === undefined || live === undefined || !Number.isFinite(dev) || !Number.isFinite(live)) {
      return { text: '-', className: '' };
    }
    const delta = dev - live;
    const value = key === 'size' ? formatBytes(Math.abs(delta)) : formatMs(Math.abs(delta));
    if (!delta) return { text: 'same', className: '' };
    return {
      text: `${delta > 0 ? '+' : '-'}${value}`,
      className: delta > 0 ? 'delta-slower' : 'delta-faster',
    };
  }

  function renderStatusPopover(): void {
    const rows: [string, MetricKey][] = [
      ['HTTP status', 'status'],
      ['Response', 'response'],
      ['DOM ready', 'dom'],
      ['Window load', 'load'],
      ['Transfer', 'size'],
    ];
    const grid = element('div', 'status-grid');
    for (const value of ['Metric', 'DEV', 'LIVE', 'Delta']) {
      grid.append(element('div', 'status-cell', value));
    }
    for (const [label, key] of rows) {
      const delta = metricDelta(key);
      grid.append(
        element('div', 'status-cell', label),
        element('div', 'status-cell', metricValue('dev', key)),
        element('div', 'status-cell', metricValue('live', key)),
        element('div', `status-cell ${delta.className}`.trim(), delta.text),
      );
    }
    const foot = element('dl', 'status-popover-foot');
    const dev = statusDetails.dev;
    const live = statusDetails.live;
    foot.append(
      element('dt', '', 'DEV'),
      element('dd', '', [dev.type, dev.cache].filter(Boolean).join(' · ') || 'No response headers'),
      element('dt', '', 'LIVE'),
      element('dd', '', [live.type, live.cache].filter(Boolean).join(' · ') || 'No response headers'),
    );
    const head = element('div', 'status-popover-head');
    head.append(
      element('strong', '', 'Response details'),
      element('span', 'status-popover-route', routeInput.value || '/'),
    );
    const note = element('p', 'status-popover-note',
      'Measured through the sitedrift proxy, in this browser. Both sides carry the same proxy overhead, so compare deltas, not absolute times.');
    statusPopover.replaceChildren(head, grid, foot, note);
  }

  function hideStatusPopover(): void {
    statusPopover.hidden = true;
    for (const badge of document.querySelectorAll('.status-badge[aria-expanded="true"]')) {
      badge.setAttribute('aria-expanded', 'false');
    }
  }

  function showStatusPopover(badge: HTMLElement): void {
    renderStatusPopover();
    statusPopover.hidden = false;
    for (const item of document.querySelectorAll('.status-badge')) {
      item.setAttribute('aria-expanded', item === badge ? 'true' : 'false');
    }
    const anchor = badge.getBoundingClientRect();
    const popover = statusPopover.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - popover.width - 8, anchor.right - popover.width));
    const below = anchor.bottom + 8;
    const top = below + popover.height <= innerHeight - 8
      ? below
      : Math.max(8, anchor.top - popover.height - 8);
    statusPopover.style.left = `${left}px`;
    statusPopover.style.top = `${top}px`;
  }

  function setStatusBadge(side: Side, status: number): void {
    statusDetails[side].status = status;
    const cls = status >= 200 && status < 300 ? 'status-ok'
      : status >= 300 && status < 400 ? 'status-warn'
      : 'status-err';
    const text = status ? String(status) : 'ERR';
    for (const badge of statusBadges(side)) {
      badge.className = 'status-badge show ' + cls;
      badge.textContent = text;
      badge.dataset.summary = statusSummary(side);
      badge.setAttribute('aria-label', `${side.toUpperCase()} returned ${text}. ${statusSummary(side)}. Click for DEV and LIVE details.`);
      badge.setAttribute('aria-haspopup', 'dialog');
      badge.setAttribute('aria-expanded', 'false');
    }
    if (!statusPopover.hidden) renderStatusPopover();
  }

  function clearStatusBadge(side: Side): void {
    for (const badge of statusBadges(side)) {
      badge.className = 'status-badge';
      badge.textContent = '';
      badge.removeAttribute('data-summary');
      badge.removeAttribute('aria-label');
      badge.removeAttribute('aria-haspopup');
      badge.removeAttribute('aria-expanded');
    }
    hideStatusPopover();
  }

  function fetchStatus(side: Side, route: string): void {
    const url = statusUrl(side, route);
    const started = performance.now();
    const read = (method: string): Promise<Response> => fetch(url, { method, cache: 'no-store', redirect: 'manual' });
    read('HEAD')
      .then((res) => (res.status === 405 || res.status === 501 ? read('GET') : res))
      .then((res) => {
        statusDetails[side] = {
          ...statusDetails[side],
          requestMs: performance.now() - started,
          type: res.headers.get('content-type') || '',
          cache: res.headers.get('cache-control') || '',
        };
        setStatusBadge(side, res.status || (res.type === 'opaqueredirect' ? 302 : 0));
      })
      .catch(() => setStatusBadge(side, 0));
  }

  function brandStrip(title: string): string {
    if (!config.brand) return title;
    const escaped = config.brand.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
    return title.replace(new RegExp('\\s*[|\u2013\u2014-]\\s*' + escaped + '.*$', 'i'), '').trim();
  }

  function updateDocTitle(): void {
    const primary = meta[order[0] ?? 'dev'];
    document.title = primary && primary.heading ? primary.heading + ' · sitedrift' : 'sitedrift';
  }

  function renderMetaDiff(): void {
    const dev = meta.dev;
    const live = meta.live;
    const diffs = {
      title: !!(dev && live) && (dev.title || '') !== (live.title || ''),
      desc: !!(dev && live) && (dev.description || '') !== (live.description || ''),
      url: !!(dev && live) && (dev.canonicalPath || '') !== (live.canonicalPath || ''),
    };
    const any = diffs.title || diffs.desc || diffs.url;
    for (const chip of document.querySelectorAll('.meta-diff')) chip.classList.toggle('show', any);
    for (const side of SIDES) {
      const card = document.querySelector('.label[data-label="' + side + '"] .seo-card');
      if (!card) continue;
      for (const key of ['title', 'desc', 'url'] as const) {
        const el = card.querySelector('[data-seo="' + key + '"]');
        if (el) el.classList.toggle('seo-diff', diffs[key]);
      }
    }
  }

  function setUrlParam(name: string, value: string | number | null): void {
    const url = new URL(location.href);
    if (value === '' || value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, String(value));
    history.replaceState(null, '', url);
  }

  function saveBool(queryName: string, storageName: string, value: boolean): void {
    storage.set(storageName, value ? '1' : '0');
    setUrlParam(queryName, value ? '1' : '0');
  }

  let toastTimer: number | undefined;
  function showToast(message: string): void {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function copyIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M8 8V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5v5A1.5 1.5 0 0 1 14.5 12H12');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', '4');
    rect.setAttribute('y', '8');
    rect.setAttribute('width', '8');
    rect.setAttribute('height', '8');
    rect.setAttribute('rx', '1.5');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.5');
    svg.append(path, rect);
    return svg;
  }

  function truncate(value: string, max: number): string {
    const chars = [...value];
    return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
  }

  function crumb(value: string): string {
    try {
      const url = new URL(value);
      const parts = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean)
        .map((part) => decodeURIComponent(part).replaceAll('-', ' '));
      return parts.length ? url.hostname + ' › ' + parts.join(' › ') : url.hostname;
    } catch {
      return value;
    }
  }

  function renderMetadata(side: Side, payload: ReadyMessage): void {
    const route = payload.route || '/';
    const source = payload.meta;
    const label = document.querySelector<HTMLElement>('.label[data-label="' + side + '"]');
    if (!label) return;
    const title = source.title.trim();
    const heading = brandStrip(title) || source.heading || 'Untitled page';
    const description = source.description;
    const canonical = source.canonical || direct(side, route);
    const siteName = source.siteName
      || config.brand
      || new URL(direct(side, route)).hostname;
    let canonicalPath = canonical;
    try { canonicalPath = new URL(canonical).pathname; } catch { /* keep the raw value */ }
    meta[side] = { title, description, canonicalPath, heading };
    statusDetails[side] = { ...statusDetails[side], ...(source.timing || {}) };
    const pageHeading = must('.page-heading', label);
    pageHeading.textContent = heading;
    pageHeading.title = title || heading;
    updateDocTitle();
    const compactTitle = must('[data-compact-title="' + side + '"]');
    compactTitle.textContent = heading;
    compactTitle.title = title || heading;
    const compactOrigin = must('[data-compact-origin="' + side + '"]');
    compactOrigin.textContent = new URL(config[side]).host + route;
    compactOrigin.title = config[side] + route;
    must('.origin', label).textContent = config[side] + route;
    setFavicon(must<HTMLImageElement>('.favicon', label), side, source.icon);
    setFavicon(must<HTMLImageElement>('[data-compact-favicon="' + side + '"]'), side, source.icon);
    must<HTMLAnchorElement>('.open-side', label).href = direct(side, route);
    const card = must('.seo-card', label);
    const sourceRow = element('div', 'seo-source');
    const seoFavicon = element('img', 'seo-favicon');
    seoFavicon.alt = '';
    setFavicon(seoFavicon, side, source.icon);
    const sourceText = element('div');
    const seoUrl = element('div', 'seo-url', crumb(canonical));
    seoUrl.dataset.seo = 'url';
    sourceText.append(element('div', 'seo-site', siteName), seoUrl);
    const menu = element('div', 'seo-menu', '⋮');
    menu.setAttribute('aria-hidden', 'true');
    sourceRow.append(seoFavicon, sourceText, menu);
    const seoTitle = element('div', `seo-title${title ? '' : ' seo-empty'}`, truncate(title || 'Missing page title', 62));
    seoTitle.dataset.seo = 'title';
    const seoDescription = element(
      'div',
      `seo-description${description ? '' : ' seo-empty'}`,
      truncate(description || 'Missing meta description', 158),
    );
    seoDescription.dataset.seo = 'desc';
    card.replaceChildren(
      element('div', 'seo-eyebrow', `${side.toUpperCase()} metadata preview`),
      sourceRow,
      seoTitle,
      seoDescription,
      seoChecks(source.checks),
    );
    const fails = source.checks.filter((check) => !check.ok).length;
    const flag = label.querySelector<HTMLElement>('.seo-flag');
    if (flag) {
      flag.hidden = fails === 0;
      flag.textContent = fails ? String(fails) : '';
      flag.title = fails ? fails + ' SEO check' + (fails === 1 ? '' : 's') + ' failing' : '';
    }
    renderMetaDiff();
  }

  function seoChecks(checks: SeoCheck[]): HTMLElement {
    const fails = checks.filter((check) => !check.ok).length;
    const container = element('div', 'seo-checks');
    const head = element('div', 'seo-checks-head');
    head.append(
      element('span', '', 'SEO checks'),
      element('span', fails ? 'bad' : 'good', fails ? `${fails} to fix` : 'all good'),
    );
    container.append(head);
    for (const check of checks) {
      const row = element('div', `seo-check ${check.ok ? 'ok' : 'bad'}`);
      row.append(
        element('span', 'seo-check-mark', check.ok ? '✓' : '✗'),
        element('span', 'seo-check-label', check.label),
      );
      if (check.note) row.append(element('span', 'seo-check-note', check.note));
      container.append(row);
    }
    return container;
  }

  function positionSeoCard(details: HTMLElement): void {
    const summary = must('summary', details);
    const card = must('.seo-card', details);
    const rect = summary.getBoundingClientRect();
    // Cap to half the viewport so the two cards can't collide, and anchor each
    // card's right edge under its SEO button so it drops within its own pane.
    const width = Math.max(260, Math.min(420, (innerWidth - 32) / 2));
    card.style.width = width + 'px';
    const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8));
    card.style.left = left + 'px';
    card.style.top = Math.min(innerHeight - 120, rect.bottom + 8) + 'px';
  }

  function googleOpen(): boolean {
    return !!document.querySelector('.label details[open]');
  }

  function setGoogleOpen(open: boolean): void {
    const all = document.querySelectorAll('.label details');
    for (const details of all) {
      if (open) details.setAttribute('open', '');
      else details.removeAttribute('open');
    }
    if (open) {
      requestAnimationFrame(() => {
        for (const details of document.querySelectorAll<HTMLElement>('.label details[open]')) positionSeoCard(details);
      });
    }
  }

  function updateLabels(route: string): void {
    for (const side of SIDES) {
      const label = must('.label[data-label="' + side + '"]');
      const pill = must('.pill', label);
      pill.className = 'pill ' + side;
      pill.textContent = side.toUpperCase();
      must('.page-heading', label).textContent = 'Loading…';
      must('[data-compact-title="' + side + '"]').textContent = 'Loading…';
      must('[data-compact-origin="' + side + '"]').textContent = new URL(config[side]).host + route;
      must('[data-compact-favicon="' + side + '"]').removeAttribute('src');
      must('.origin', label).textContent = config[side] + route;
      setFavicon(must<HTMLImageElement>('.favicon', label), side);
      must<HTMLAnchorElement>('.open-side', label).href = direct(side, route);
      meta[side] = null;
      statusDetails[side] = {};
      clearStatusBadge(side);
    }
    renderMetaDiff();
  }

  function applyOrder(): void {
    order.forEach((side, index) => {
      const pane = must('[data-pane="' + side + '"]');
      pane.style.order = String(index);
      pane.classList.toggle('overlay-top', index === 1);
      must('.label[data-label="' + side + '"]').style.order = String(index);
    });
  }

  function go(value: string = routeInput.value): void {
    const route = normalizeRoute(value);
    routeInput.value = route;
    updateLabels(route);
    frameReady.dev = false;
    frameReady.live = false;
    frame('dev').src = proxied('dev', route);
    frame('live').src = proxied('live', route);
    const url = new URL(location.href);
    url.searchParams.set('path', route);
    history.replaceState(null, '', url);
  }

  function setSplit(percent: number): void {
    const value = Math.max(15, Math.min(85, percent));
    root.style.setProperty('--split', value + '%');
    divider.setAttribute('aria-valuenow', String(Math.round(value)));
    storage.set('site-compare-split', String(value));
    setUrlParam('split', Math.round(value * 10) / 10);
  }

  // Overlay and diff are only legible if both panes scroll in lockstep, so
  // they force pixel-exact linked scrolling regardless of the user's toggle.
  function stacked(): boolean { return viewMode === 'overlay'; }
  function linked(): boolean { return syncScroll || stacked(); }
  function effScrollMode(): ScrollMode { return stacked() ? 'exact' : scrollMode; }

  function applyFrameSettings(side: Side): void {
    framePost(side, { type: 'settings', linked: linked(), mirror: mirrorLinks, stacked: stacked() });
  }

  function setLinkedScroll(sourceSide: Side, requestedY: number): void {
    const otherSide = otherOf(sourceSide);
    const sourceMax = frameState[sourceSide].max;
    const sourceY = Math.max(0, Math.min(sourceMax, requestedY));
    suppressScrollUntil[sourceSide] = Date.now() + 120;
    if (effScrollMode() === 'exact') {
      const sharedMax = Math.min(sourceMax, frameState[otherSide].max);
      const sharedY = Math.min(sharedMax, sourceY);
      suppressScrollUntil[otherSide] = Date.now() + 120;
      frameState[sourceSide].y = sharedY;
      frameState[otherSide].y = sharedY;
      framePost(sourceSide, { type: 'scroll', y: sharedY });
      framePost(otherSide, { type: 'scroll', y: sharedY });
    } else {
      frameState[sourceSide].y = sourceY;
      framePost(sourceSide, { type: 'scroll', y: sourceY });
      alignSide(sourceSide, otherSide);
    }
  }

  function alignSide(sourceSide: Side, targetSide: Side): void {
    let targetY = frameState[sourceSide].y;
    if (effScrollMode() === 'ratio') {
      const sourceMax = frameState[sourceSide].max;
      const ratio = sourceMax ? frameState[sourceSide].y / sourceMax : 0;
      targetY = ratio * frameState[targetSide].max;
    }
    suppressScrollUntil[targetSide] = Date.now() + (effScrollMode() === 'exact' ? 120 : 600);
    frameState[targetSide].y = targetY;
    framePost(targetSide, { type: 'scroll', y: targetY });
  }

  function syncFrom(side: Side): void {
    if (!linked() || Date.now() < suppressScrollUntil[side]) return;
    // A scroll event that clears the suppress window is a genuine user scroll on
    // `side`, so hand that pane ownership: the counter-scroll we push to the other
    // side lands inside its suppress window and never reaches here. This lets either
    // pane lead with native momentum instead of the first scroller owning forever.
    scrollOwner = side;
    if (effScrollMode() === 'exact') {
      alignSide(side, otherOf(side));
      return;
    }
    cancelAnimationFrame(scrollFrames[side]);
    scrollFrames[side] = requestAnimationFrame(() => {
      const otherSide = otherOf(side);
      alignSide(side, otherSide);
      for (const timer of settleTimers[side]) clearTimeout(timer);
      settleTimers[side] = [80, 240].map((delay) => setTimeout(() => {
        if (scrollOwner === side) alignSide(side, otherSide);
      }, delay));
    });
  }

  function markScrollOwner(side: Side): void {
    scrollOwner = side;
  }

  function toggleDifference(): void {
    if (viewMode === 'overlay' && overlayBlend === 'difference') setMode('split');
    else { setMode('overlay'); setOverlayBlend('difference'); }
  }

  function runFrameKey(side: Side, message: KeyMessage): void {
    const { key } = message;
    const lower = key.toLowerCase();
    if (lower === 'r') must('[data-action="reload"]').click();
    else if (lower === 's') must('[data-action="swap"]').click();
    else if (lower === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
    else if (lower === 'd') toggleDifference();
    else if (lower === '0') setSplit(50);
    else if (key === '/') { routeInput.focus(); routeInput.select(); }
    else if (linked()) {
      const y = message.y ?? 0;
      const height = message.height ?? 0;
      let next: number | null = null;
      if (key === 'ArrowDown') next = y + 44;
      if (key === 'ArrowUp') next = y - 44;
      if (key === 'PageDown' || (key === ' ' && !message.shift)) next = y + height * .85;
      if (key === 'PageUp' || (key === ' ' && message.shift)) next = y - height * .85;
      if (key === 'Home') next = 0;
      if (key === 'End') next = message.max ?? 0;
      if (next !== null) {
        markScrollOwner(side);
        setLinkedScroll(side, next);
      }
    }
  }

  /** Validates and normalizes what a framed page posted. Anything else it sends is ignored. */
  function parseFrameMessage(data: unknown): (FrameMessage & { side: Side }) | null {
    if (!isRecord(data) || data.source !== 'sitedrift-frame') return null;
    const side = data.side;
    if (side !== 'dev' && side !== 'live') return null;
    switch (data.type) {
      case 'ready': {
        const raw = isRecord(data.meta) ? data.meta : {};
        const timing = isRecord(raw.timing) ? raw.timing : null;
        const rawChecks: unknown[] = Array.isArray(raw.checks) ? raw.checks : [];
        const checks: SeoCheck[] = rawChecks.filter(isRecord).map((check) => {
          const note = typeof check.note === 'string' ? check.note : undefined;
          return { label: str(check.label), ok: check.ok === true, ...(note === undefined ? {} : { note }) };
        });
        const parsed: PageMeta = {
          title: str(raw.title),
          description: str(raw.description),
          canonical: str(raw.canonical),
          heading: str(raw.heading),
          siteName: str(raw.siteName),
          icon: str(raw.icon),
          checks,
          timing: timing && {
            response: num(timing.response),
            dom: num(timing.dom),
            load: num(timing.load),
            transfer: num(timing.transfer),
            decoded: num(timing.decoded),
          },
        };
        return { type: 'ready', side, route: str(data.route) || '/', meta: parsed };
      }
      case 'scroll':
        return { type: 'scroll', side, y: num(data.y), max: num(data.max) };
      case 'wheel':
        return { type: 'wheel', side, delta: num(data.delta), mode: num(data.mode), height: num(data.height), y: num(data.y) };
      case 'navigate':
        return { type: 'navigate', side, route: str(data.route) };
      case 'dismiss':
        return { type: 'dismiss', side };
      case 'key':
        return {
          type: 'key',
          side,
          key: str(data.key),
          shift: data.shift === true,
          y: num(data.y),
          height: num(data.height),
          max: num(data.max),
        };
      default:
        return null;
    }
  }

  addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = parseFrameMessage(event.data);
    if (!message) return;
    const side = message.side;
    if ((!config.hosted && event.origin !== config.frameOrigins[side])
      || event.source !== frame(side).contentWindow) return;
    if (message.type === 'ready') {
      frameReady[side] = true;
      renderMetadata(side, message);
      fetchStatus(side, message.route);
      applyFrameSettings(side);
    } else if (message.type === 'scroll') {
      frameState[side] = { y: message.y, max: message.max };
      // In Solo only the visible pane leads. The hidden one is aligned when it
      // is swapped in, so its own scroll events never move the visible page.
      if (viewMode !== 'solo') syncFrom(side);
    } else if (message.type === 'wheel') {
      const delta = message.mode === 1 ? message.delta * 18
        : message.mode === 2 ? message.delta * message.height : message.delta;
      markScrollOwner(side);
      setLinkedScroll(side, frameState[side].y + delta);
    } else if (message.type === 'navigate') {
      go(message.route);
    } else if (message.type === 'dismiss') {
      closePopovers();
    } else {
      runFrameKey(side, message);
    }
  });

  function closePopovers(): void {
    for (const details of document.querySelectorAll('details[open]')) details.removeAttribute('open');
    hideStatusPopover();
    if (notesOpen && !notesDocked()) setNotesOpen(false);
  }
  scrollButton.addEventListener('click', () => {
    syncScroll = !syncScroll;
    scrollButton.classList.toggle('active', syncScroll);
    saveBool('scroll', 'site-compare-scroll', syncScroll);
    for (const side of SIDES) applyFrameSettings(side);
    renderSettings();
    if (syncScroll) syncFrom(focusSide);
  });
  function renderSetting(button: HTMLElement, active: boolean, stateText: string): void {
    button.classList.toggle('active', active);
    must('.state', button).textContent = stateText;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  function renderSettings(): void {
    renderSetting(mobileButton, mobileMode, mobileMode ? 'On' : 'Off');
    renderSetting(mirrorButton, mirrorLinks, mirrorLinks ? 'On' : 'Off');
    renderSetting(scrollModeButton, scrollMode === 'exact', scrollMode === 'exact' ? 'Exact' : 'Proportional');
    scrollButton.title = syncScroll ? 'Locked scrolling is on' : 'Locked scrolling is off';
    scrollButton.setAttribute('aria-pressed', syncScroll ? 'true' : 'false');
  }
  function renderScrollMode(): void {
    must('[data-scroll-label]').textContent =
      scrollMode === 'exact' ? 'Locked scroll' : 'Ratio scroll';
    renderSettings();
  }
  scrollModeButton.addEventListener('click', () => {
    scrollMode = scrollMode === 'exact' ? 'ratio' : 'exact';
    storage.set('site-compare-scroll-mode', scrollMode);
    setUrlParam('scrollMode', scrollMode);
    renderScrollMode();
    for (const side of SIDES) applyFrameSettings(side);
    if (syncScroll) syncFrom(focusSide);
  });
  mirrorButton.addEventListener('click', () => {
    mirrorLinks = !mirrorLinks;
    saveBool('mirror', 'site-compare-mirror', mirrorLinks);
    for (const side of SIDES) applyFrameSettings(side);
    renderSettings();
  });
  mobileButton.addEventListener('click', () => {
    mobileMode = !mobileMode;
    app.classList.toggle('mobile', mobileMode);
    storage.set('site-compare-mode', mobileMode ? 'mobile' : 'desktop');
    setUrlParam('mode', mobileMode ? 'mobile' : 'desktop');
    renderSettings();
  });
  function setOverlayAmount(value: number): void {
    overlayAmount = Math.max(0, Math.min(100, Math.round(value)));
    root.style.setProperty('--overlay', (overlayAmount / 100).toFixed(3));
    for (const slider of overlaySliders) slider.value = String(overlayAmount);
    storage.set('site-compare-overlay-amount', String(overlayAmount));
    setUrlParam('overlayAmount', overlayAmount);
  }
  function renderModes(): void {
    for (const button of modeButtons) {
      const active = button.dataset.mode === viewMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const diffActive = viewMode === 'overlay' && overlayBlend === 'difference';
    for (const button of blendButtons) {
      button.classList.toggle('active', diffActive);
      button.setAttribute('aria-pressed', diffActive ? 'true' : 'false');
    }
  }
  // Split / Solo / Overlay are the mutually-exclusive layouts; Diff is the
  // overlay's blend (the slider's far end), toggled within Overlay.
  function setMode(requested: string | undefined): void {
    const mode: ViewMode = isViewMode(requested) ? requested : 'split';
    const leavingSolo = viewMode === 'solo' && mode !== 'solo';
    viewMode = mode;
    app.classList.toggle('solo', mode === 'solo');
    app.classList.toggle('overlay', mode === 'overlay');
    app.classList.toggle('diff', mode === 'overlay' && overlayBlend === 'difference');
    app.dataset.focus = focusSide;
    storage.set('site-compare-view', mode);
    setUrlParam('view', mode === 'split' ? null : mode);
    renderModes();
    applyOrder();
    // Overlay forces scroll-lock, so refresh scrollbar hiding + re-align.
    for (const side of SIDES) applyFrameSettings(side);
    if (leavingSolo && linked()) alignSide(focusSide, otherOf(focusSide));
    else if (stacked()) alignSide(order[1] ?? 'live', order[0] ?? 'dev');
  }
  function setOverlayBlend(blend: string): void {
    overlayBlend = blend === 'difference' ? 'difference' : 'opacity';
    app.classList.toggle('diff', viewMode === 'overlay' && overlayBlend === 'difference');
    storage.set('site-compare-overlay-blend', overlayBlend);
    setUrlParam('overlayBlend', overlayBlend === 'difference' ? 'difference' : null);
    renderModes();
  }
  for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
  for (const identity of document.querySelectorAll<HTMLElement>('.compact-side')) {
    identity.addEventListener('click', () => {
      if (viewMode !== 'solo') return;
      focusSide = identity.dataset.compactSide === 'dev' ? 'live' : 'dev';
      app.dataset.focus = focusSide;
      renderModes();
    });
  }
  for (const badge of document.querySelectorAll<HTMLElement>('.status-badge')) {
    badge.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = !statusPopover.hidden && badge.getAttribute('aria-expanded') === 'true';
      if (wasOpen) hideStatusPopover();
      else showStatusPopover(badge);
    });
  }
  for (const slider of overlaySliders) slider.addEventListener('input', () => {
    if (viewMode !== 'overlay') setMode('overlay');
    if (overlayBlend === 'difference') setOverlayBlend('opacity');
    setOverlayAmount(Number(slider.value));
  });
  for (const button of blendButtons) button.addEventListener('click', () => {
    if (viewMode !== 'overlay') setMode('overlay');
    setOverlayBlend(overlayBlend === 'difference' ? 'opacity' : 'difference');
  });

  function setCompact(value: boolean): void {
    compactMode = value;
    app.classList.toggle('compact', compactMode);
    saveBool('compact', 'site-compare-compact', compactMode);
  }
  for (const button of document.querySelectorAll('[data-action="compact"]')) {
    button.addEventListener('click', () => setCompact(!compactMode));
  }

  /** Keeps the entries that have the fields the viewer renders; anything else is not a note. */
  function asNotes(value: unknown): ViewerNote[] {
    const items: unknown[] = Array.isArray(value) ? value : [];
    const notes: ViewerNote[] = [];
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') continue;
      const note: ViewerNote = {
        id: item.id,
        text: item.text,
        author: str(item.author),
        route: str(item.route),
        side: item.side === 'dev' || item.side === 'live' ? item.side : null,
        done: item.done === true,
      };
      if (typeof item.ts === 'number') note.ts = item.ts;
      if (typeof item.createdAt === 'string') note.createdAt = item.createdAt;
      notes.push(note);
    }
    return notes;
  }

  function applyNotes(notes: unknown): void {
    const list = asNotes(notes);
    const signature = JSON.stringify(list);
    if (signature === notesSignature) return;
    notesSignature = signature;
    reviewNotes = list;
    renderNotes();
  }

  async function notesPull(): Promise<void> {
    if (config.localNotes) {
      try { applyNotes(JSON.parse(storage.get(localNotesKey) || '[]')); } catch { applyNotes([]); }
      return;
    }
    try {
      const res = await fetch(config.api + '/notes', { cache: 'no-store', headers: apiHeaders });
      const data: unknown = await res.json();
      applyNotes(isRecord(data) ? data.notes : undefined);
    } catch {
      // The server is unreachable for now; the next poll tries again.
    }
  }

  async function notesPost(op: NoteRequest): Promise<void> {
    if (config.localNotes) {
      let notes = [...reviewNotes];
      if (op.op === 'add') {
        notes.push({
          id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()),
          text: op.text,
          author: op.author,
          route: op.route,
          side: op.side,
          done: false,
          createdAt: new Date().toISOString(),
        });
      } else if (op.op === 'toggle') {
        notes = notes.map((note) => note.id === op.id ? { ...note, done: !note.done } : note);
      } else {
        notes = notes.filter((note) => note.id !== op.id);
      }
      storage.set(localNotesKey, JSON.stringify(notes));
      applyNotes(notes);
      return;
    }
    try {
      const res = await fetch(config.api + '/notes', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(op),
      });
      const data: unknown = await res.json();
      applyNotes(isRecord(data) ? data.notes : undefined);
    } catch {
      // The note was not saved; the next poll shows the server's list.
    }
  }

  function authorClass(name: string): string {
    const who = name.toLowerCase();
    return who === 'joe' ? 'joe' : who === 'claude' ? 'claude' : 'other';
  }

  function renderNotes(): void {
    noteList.replaceChildren();
    for (const note of reviewNotes) {
      const item = document.createElement('li');
      if (note.done) item.classList.add('done');

      const metaRow = element('div', 'note-meta');
      metaRow.append(element('span', 'note-author ' + authorClass(note.author), note.author || 'note'));
      const where = [note.side ? note.side.toUpperCase() : '', note.route && note.route !== '/' ? note.route : '']
        .filter(Boolean).join(' · ');
      if (where) metaRow.append(element('span', 'note-where', where));
      item.append(metaRow);

      const text = element('div', 'note-text', note.text);
      if (note.route) {
        const route = note.route;
        const noteSide = note.side;
        text.classList.add('note-go');
        text.title = 'Go to ' + route + (noteSide ? ' · ' + noteSide.toUpperCase() : '');
        text.addEventListener('click', () => {
          if (noteSide) { focusSide = noteSide; app.dataset.focus = focusSide; renderModes(); }
          go(route);
        });
      }
      item.append(text);

      const toggle = element('button', 'note-toggle', note.done ? '↺' : '✓');
      toggle.title = note.done ? 'Reopen note' : 'Mark done';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.addEventListener('click', () => notesPost({ op: 'toggle', id: note.id }));
      item.append(toggle);

      const copy = element('button', 'note-copy');
      copy.title = 'Copy a link to this note';
      copy.setAttribute('aria-label', 'Copy link to this note');
      copy.append(copyIcon());
      copy.addEventListener('click', async () => {
        const url = new URL(location.href);
        url.searchParams.set('path', note.route || '/');
        await navigator.clipboard.writeText(url.href);
        showToast('Note link copied');
      });
      item.append(copy);

      const remove = element('button', 'remove-note', '×');
      remove.setAttribute('aria-label', 'Remove note');
      remove.addEventListener('click', () => notesPost({ op: 'remove', id: note.id }));
      item.append(remove);

      noteList.append(item);
    }
    const open = reviewNotes.filter((note) => !note.done).length;
    for (const count of document.querySelectorAll<HTMLElement>('[data-action="notes"] .count')) {
      count.textContent = String(open);
      count.style.display = open ? '' : 'none';
    }
  }

  const dockButton = must('[data-action="notes-dock"]');
  const notesButtons = [...document.querySelectorAll<HTMLElement>('[data-action="notes"]')];
  let notesTrigger: HTMLElement | null = null;
  function notesDocked(): boolean {
    return dockMode && innerWidth > 600;
  }
  function applyDock(): void {
    // Dock pushes the panes aside; float overlays them.
    app.classList.toggle('drawer-dock', notesOpen && notesDocked());
    dockButton.classList.toggle('active', dockMode);
    dockButton.setAttribute('aria-pressed', dockMode ? 'true' : 'false');
  }
  function setNotesOpen(value: boolean, { restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
    notesOpen = value;
    notesDrawer.classList.toggle('open', notesOpen);
    notesDrawer.toggleAttribute('inert', !notesOpen);
    notesDrawer.setAttribute('aria-hidden', notesOpen ? 'false' : 'true');
    for (const button of notesButtons) button.setAttribute('aria-expanded', notesOpen ? 'true' : 'false');
    setUrlParam('notes', notesOpen ? '1' : '0');
    applyDock();
    if (notesOpen) noteInput.focus();
    else if (restoreFocus && notesTrigger?.isConnected) notesTrigger.focus();
  }
  dockButton.addEventListener('click', () => {
    dockMode = !dockMode;
    saveBool('dock', 'site-compare-dock', dockMode);
    applyDock();
  });
  for (const button of notesButtons) {
    button.addEventListener('click', () => {
      notesTrigger = button;
      setNotesOpen(!notesOpen);
    });
  }
  must('[data-action="notes-close"]').addEventListener('click', () => setNotesOpen(false));
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    let handled = false;
    if (!statusPopover.hidden) {
      hideStatusPopover();
      handled = true;
    }
    for (const details of document.querySelectorAll('details[open]')) {
      details.removeAttribute('open');
      handled = true;
    }
    if (notesOpen) {
      setNotesOpen(false);
      handled = true;
    }
    if (handled && (event.target === noteInput || event.target === routeInput)) {
      (event.target === noteInput ? noteInput : routeInput).blur();
    }
  });
  // Auto-grow the compose box to its content (scroll past a cap), with a
  // floor the user can raise by dragging the top grip.
  const NOTE_MIN = 76;
  let noteFloor = NOTE_MIN;
  function autosizeNote(): void {
    const hardMax = Math.round(innerHeight * 0.6);
    noteInput.style.height = 'auto';
    const needed = noteInput.scrollHeight;
    const height = Math.min(hardMax, Math.max(NOTE_MIN, noteFloor, needed));
    noteInput.style.height = height + 'px';
    noteInput.style.overflowY = needed > height ? 'auto' : 'hidden';
  }
  noteInput.addEventListener('input', autosizeNote);
  const noteGrip = must('.note-grip');
  noteGrip.addEventListener('pointerdown', (event) => {
    noteGrip.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = noteInput.offsetHeight;
    const onMove = (move: PointerEvent): void => {
      noteFloor = Math.max(NOTE_MIN, Math.min(Math.round(innerHeight * 0.6), startHeight + (startY - move.clientY)));
      autosizeNote();
    };
    const onUp = (up: PointerEvent): void => {
      noteGrip.releasePointerCapture(up.pointerId);
      noteGrip.removeEventListener('pointermove', onMove);
      noteGrip.removeEventListener('pointerup', onUp);
    };
    noteGrip.addEventListener('pointermove', onMove);
    noteGrip.addEventListener('pointerup', onUp);
  });
  const noteAddButton = must('[data-action="note-add"]');
  noteAddButton.addEventListener('click', () => {
    const text = noteInput.value.trim();
    if (!text) return;
    noteInput.value = '';
    autosizeNote();
    const side = viewMode === 'solo' ? focusSide : null;
    notesPost({ op: 'add', text, author: config.author || 'joe', route: routeInput.value, side });
  });
  noteInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') noteAddButton.click();
  });
  must('[data-action="note-export"]').addEventListener('click', () => {
    const link = document.createElement('a');
    if (config.localNotes) {
      const lines = ['# sitedrift review notes', ''];
      for (const note of reviewNotes) {
        lines.push(`- [${note.done ? 'x' : ' '}] ${note.text} (${note.side || 'both'} ${note.route || '/'})`);
      }
      link.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/markdown' }));
    } else {
      link.href = '/notes.md';
    }
    link.download = 'site-compare-notes.md';
    link.click();
    showToast('Exported notes .md');
  });
  const vaultButton = must('[data-action="note-vault"]');
  if (config.vault) vaultButton.hidden = false;
  vaultButton.addEventListener('click', async () => {
    try {
      const res = await fetch(config.api + '/notes/save', { method: 'POST', headers: apiHeaders, body: '{}' });
      const data: unknown = await res.json();
      const failure = isRecord(data) && typeof data.error === 'string' ? data.error : '';
      showToast(isRecord(data) && data.ok ? 'Saved to vault' : (failure || 'Vault save failed'));
    } catch {
      showToast('Vault save failed');
    }
  });
  const localNotesNotice = must('.local-notes-notice');
  if (config.localNotes) localNotesNotice.hidden = false;

  divider.addEventListener('pointerdown', (event) => {
    divider.setPointerCapture(event.pointerId);
    app.classList.add('dragging');
    divider.dataset.pointerDrag = '1';
  });
  divider.addEventListener('pointermove', (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    setSplit(event.clientX / innerWidth * 100);
  });
  divider.addEventListener('pointerup', (event) => {
    divider.releasePointerCapture(event.pointerId);
    app.classList.remove('dragging');
    divider.blur();
    delete divider.dataset.pointerDrag;
  });
  divider.addEventListener('keydown', (event) => {
    const current = parseFloat(getComputedStyle(root).getPropertyValue('--split'));
    if (event.key === 'ArrowLeft') setSplit(current - (event.shiftKey ? 10 : 2));
    if (event.key === 'ArrowRight') setSplit(current + (event.shiftKey ? 10 : 2));
  });

  must('[data-action="go"]').addEventListener('click', () => go());
  for (const button of document.querySelectorAll('[data-action="reload"]')) {
    button.addEventListener('click', () => {
      for (const side of SIDES) framePost(side, { type: 'reload' });
    });
  }
  for (const button of document.querySelectorAll('[data-action="swap"]')) {
    button.addEventListener('click', () => {
      if (viewMode === 'solo') {
        const nextSide = otherOf(focusSide);
        if (syncScroll) alignSide(focusSide, nextSide);
        focusSide = nextSide;
        app.dataset.focus = focusSide;
        setUrlParam('focus', focusSide);
        renderSettings();
      } else {
        order.reverse();
        applyOrder();
        updateDocTitle();
        setUrlParam('swap', order[0] === 'live' ? '1' : '0');
      }
    });
  }
  // Opening one Google preview opens both, anchored under their buttons.
  for (const summary of document.querySelectorAll('.label details > summary')) {
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      setGoogleOpen(!googleOpen());
    });
  }
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    for (const details of document.querySelectorAll('details.settings[open], details.help[open]')) {
      if (!target || !details.contains(target)) details.removeAttribute('open');
    }
    if (googleOpen() && !target?.closest('.label')) setGoogleOpen(false);
    if (!statusPopover.hidden && !target?.closest('.status-popover') && !target?.closest('.status-badge')) {
      hideStatusPopover();
    }
    if (notesOpen && !notesDocked() && !target?.closest('.review-drawer') && !target?.closest('[data-action="notes"]')) {
      setNotesOpen(false, { restoreFocus: false });
    }
  });
  document.addEventListener('pointerup', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea')) return;
    const control = target?.closest<HTMLElement>('button, summary');
    if (control && control !== document.activeElement) return;
    control?.blur();
    getSelection()?.removeAllRanges();
  });
  addEventListener('resize', () => {
    hideStatusPopover();
    applyDock();
    for (const details of document.querySelectorAll<HTMLElement>('.label details[open]')) positionSeoCard(details);
  });
  routeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  addEventListener('keydown', (event) => {
    if (event.target === routeInput || event.target === noteInput) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'r') must('[data-action="reload"]').click();
    if (event.key === 's') must('[data-action="swap"]').click();
    if (event.key === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
    if (event.key === 'd') toggleDifference();
    if (event.key === '0') setSplit(50);
    if (event.key === '/') { event.preventDefault(); routeInput.focus(); routeInput.select(); }
  });

  const initialSplit = Number(params.get('split') || storage.get('site-compare-split')) || 50;
  scrollButton.classList.toggle('active', syncScroll);
  renderScrollMode();
  app.classList.toggle('mobile', mobileMode);
  app.classList.toggle('compact', compactMode);
  app.dataset.focus = focusSide;
  setOverlayAmount(overlayAmount);
  renderSettings();
  setNotesOpen(notesOpen, { restoreFocus: false });
  applyDock();
  renderNotes();
  autosizeNote();
  setSplit(initialSplit);
  setMode(viewMode);
  go(params.get('path') || config.initialPath || '/');
  notesPull();
  if (!config.localNotes) setInterval(notesPull, 4000);
})();
