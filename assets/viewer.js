    const config = window.__SITEDRIFT_CONFIG__;
    delete window.__SITEDRIFT_CONFIG__;
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
    const app = document.querySelector('.app');
    const routeInput = document.querySelector('.route');
    const divider = document.querySelector('.divider');
    const scrollButton = document.querySelector('[data-action="scroll"]');
    const scrollModeButton = document.querySelector('[data-action="scroll-mode"]');
    const mirrorButton = document.querySelector('[data-action="mirror"]');
    const mobileButton = document.querySelector('[data-action="mobile"]');
    const modeButtons = [...document.querySelectorAll('[data-mode]')];
    const overlaySliders = [...document.querySelectorAll('.overlay-slider input')];
    const blendButtons = [...document.querySelectorAll('[data-action="overlay-blend"]')];
    const notesDrawer = document.querySelector('.review-drawer');
    const noteList = document.querySelector('.note-list');
    const noteInput = document.querySelector('.note-compose textarea');
    const toast = document.querySelector('.toast');
    const statusPopover = document.querySelector('.status-popover');
    const params = new URLSearchParams(location.search);
    const suppressScrollUntil = { dev: 0, live: 0 };
    const scrollFrames = { dev: 0, live: 0 };
    const settleTimers = { dev: [], live: [] };
    const frameState = { dev: { y: 0, max: 0 }, live: { y: 0, max: 0 } };
    let order = params.get('swap') === '1' ? ['live', 'dev'] : ['dev', 'live'];
    let syncScroll = queryOrStoredBool('scroll', 'site-compare-scroll', !!config.hosted);
    let scrollMode = params.get('scrollMode') || localStorage.getItem('site-compare-scroll-mode') || 'exact';
    if (!['exact', 'ratio'].includes(scrollMode)) scrollMode = 'exact';
    let mirrorLinks = queryOrStoredBool('mirror', 'site-compare-mirror', !!config.hosted);
    let mobileMode = (params.get('mode') || localStorage.getItem('site-compare-mode')) === 'mobile';
    let compactMode = queryOrStoredBool('compact', 'site-compare-compact', !!config.hosted);
    const storedView = localStorage.getItem('site-compare-view');
    let viewMode = params.get('view')
      || (params.get('overlay') === '1' ? 'overlay' : params.get('solo') === '1' ? 'solo' : null)
      || storedView
      || (config.hosted ? 'solo' : null)
      || (innerWidth <= 600 ? 'solo' : 'split');
    let overlayBlend = (params.get('overlayBlend') || localStorage.getItem('site-compare-overlay-blend')) === 'difference' ? 'difference' : 'opacity';
    if (viewMode === 'diff') { viewMode = 'overlay'; overlayBlend = 'difference'; } // back-compat
    if (!['split', 'solo', 'overlay'].includes(viewMode)) viewMode = 'split';
    let overlayAmount = Number(params.get('overlayAmount') ?? localStorage.getItem('site-compare-overlay-amount'));
    if (!Number.isFinite(overlayAmount)) overlayAmount = 50;
    let focusSide = params.get('focus') === 'live' ? 'live' : params.get('focus') === 'dev' ? 'dev' : 'dev';
    let reviewNotes = [];
    let notesSignature = '';
    let notesOpen = params.get('notes') === '1';
    let dockMode = queryOrStoredBool('dock', 'site-compare-dock', true);
    let scrollOwner = null;
    const meta = { dev: null, live: null };
    const statusDetails = { dev: {}, live: {} };
    const apiHeaders = {
      authorization: 'Bearer ' + config.token,
      'content-type': 'application/json',
    };
    const localNotesKey = 'sitedrift-preview-notes:' + location.host + ':' + config.live;

    function queryOrStoredBool(queryName, storageName, fallback) {
      if (params.has(queryName)) return params.get(queryName) === '1';
      const stored = localStorage.getItem(storageName);
      return stored === null ? fallback : stored === '1';
    }

    function normalizeRoute(value) {
      try {
        if (/^https?:\/\//.test(value)) {
          const parsed = new URL(value);
          value = parsed.pathname + parsed.search + parsed.hash;
        }
      } catch {}
      value = value.trim() || '/';
      return value.startsWith('/') ? value : '/' + value;
    }

    function frame(side) { return document.querySelector('iframe[data-side="' + side + '"]'); }
    function proxyPath(side) { return config.hosted ? '/__sitedrift/' + side : '/__' + side; }
    function proxied(side, route) { return config.frameOrigins[side] + proxyPath(side) + normalizeRoute(route); }
    function statusUrl(side, route) { return proxyPath(side) + normalizeRoute(route); }
    function direct(side, route) {
      return config.hosted && side === 'dev'
        ? location.origin + proxyPath(side) + normalizeRoute(route)
        : config[side] + normalizeRoute(route);
    }
    const neutralSiteIcon = 'data:image/svg+xml,'
      + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
        + '<circle cx="12" cy="12" r="10" fill="#64748b"/>'
        + '<path d="M2.8 12h18.4M12 2.8c3 3 3 15.4 0 18.4M12 2.8c-3 3-3 15.4 0 18.4" '
        + 'fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>'
        + '</svg>');
    function setFavicon(image, side, declared = '') {
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
        if (index < candidates.length) image.src = candidates[index];
        else image.onerror = null;
      };
      image.src = candidates[0];
    }
    function framePost(side, type, data = {}) {
      frame(side).contentWindow?.postMessage(
        { source: 'sitedrift-parent', side, type, ...data },
        config.hosted ? '*' : config.frameOrigins[side],
      );
    }

    function statusBadges(side) {
      return [
        document.querySelector('.label[data-label="' + side + '"] .status-badge'),
        document.querySelector('[data-compact-side="' + side + '"] .status-badge'),
      ].filter(Boolean);
    }

    function formatMs(value) {
      return Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '';
    }

    function formatBytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '';
      if (value < 1024) return `${Math.round(value)} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function statusSummary(side) {
      const detail = statusDetails[side];
      if (detail.response) return `Response ${formatMs(detail.response)}`;
      if (detail.requestMs) return `Status check ${formatMs(detail.requestMs)}`;
      return 'Click for response details';
    }

    function metricValue(side, key) {
      const detail = statusDetails[side];
      if (key === 'status') return detail.status ? String(detail.status) : 'ERR';
      if (key === 'size') return formatBytes(detail.transfer || detail.decoded) || '-';
      return formatMs(detail[key]) || '-';
    }

    function metricDelta(key) {
      if (key === 'status') return { text: '-', className: '' };
      const dev = key === 'size'
        ? statusDetails.dev.transfer || statusDetails.dev.decoded
        : statusDetails.dev[key];
      const live = key === 'size'
        ? statusDetails.live.transfer || statusDetails.live.decoded
        : statusDetails.live[key];
      if (!Number.isFinite(dev) || !Number.isFinite(live)) return { text: '-', className: '' };
      const delta = dev - live;
      const value = key === 'size' ? formatBytes(Math.abs(delta)) : formatMs(Math.abs(delta));
      if (!delta) return { text: 'same', className: '' };
      return {
        text: `${delta > 0 ? '+' : '-'}${value}`,
        className: delta > 0 ? 'delta-slower' : 'delta-faster',
      };
    }

    function renderStatusPopover() {
      const rows = [
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
      statusPopover.replaceChildren(head, grid, foot);
    }

    function hideStatusPopover() {
      statusPopover.hidden = true;
      for (const badge of document.querySelectorAll('.status-badge[aria-expanded="true"]')) {
        badge.setAttribute('aria-expanded', 'false');
      }
    }

    function showStatusPopover(badge) {
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

    function setStatusBadge(side, status) {
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

    function clearStatusBadge(side) {
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

    function fetchStatus(side, route) {
      const url = statusUrl(side, route);
      const started = performance.now();
      const read = (method) => fetch(url, { method, cache: 'no-store', redirect: 'manual' });
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

    function brandStrip(title) {
      if (!config.brand) return title;
      const escaped = config.brand.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
      return title.replace(new RegExp('\\s*[|\u2013\u2014-]\\s*' + escaped + '.*$', 'i'), '').trim();
    }

    function updateDocTitle() {
      const primary = meta[order[0]];
      document.title = primary && primary.heading ? primary.heading + ' · sitedrift' : 'sitedrift';
    }

    function renderMetaDiff() {
      const dev = meta.dev;
      const live = meta.live;
      const diffs = {
        title: !!(dev && live) && (dev.title || '') !== (live.title || ''),
        desc: !!(dev && live) && (dev.description || '') !== (live.description || ''),
        url: !!(dev && live) && (dev.canonicalPath || '') !== (live.canonicalPath || ''),
      };
      const any = diffs.title || diffs.desc || diffs.url;
      for (const chip of document.querySelectorAll('.meta-diff')) chip.classList.toggle('show', any);
      for (const side of ['dev', 'live']) {
        const card = document.querySelector('.label[data-label="' + side + '"] .seo-card');
        if (!card) continue;
        for (const key of ['title', 'desc', 'url']) {
          const el = card.querySelector('[data-seo="' + key + '"]');
          if (el) el.classList.toggle('seo-diff', diffs[key]);
        }
      }
    }

    function setUrlParam(name, value) {
      const url = new URL(location.href);
      if (value === '' || value === null || value === undefined) url.searchParams.delete(name);
      else url.searchParams.set(name, String(value));
      history.replaceState(null, '', url);
    }

    function saveBool(queryName, storageName, value) {
      localStorage.setItem(storageName, value ? '1' : '0');
      setUrlParam(queryName, value ? '1' : '0');
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function copyIcon() {
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

    function truncate(value, max) {
      const chars = [...String(value || '')];
      return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('').trimEnd() + '…';
    }

    function crumb(value) {
      try {
        const url = new URL(value);
        const parts = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean)
          .map((part) => decodeURIComponent(part).replaceAll('-', ' '));
        return parts.length ? url.hostname + ' › ' + parts.join(' › ') : url.hostname;
      } catch {
        return value;
      }
    }

    function renderMetadata(side, payload) {
      const route = payload.route || '/';
      const source = payload.meta || {};
      const label = document.querySelector('.label[data-label="' + side + '"]');
      if (!label) return;
      const title = (source.title || '').trim();
      const heading = brandStrip(title) || source.heading || 'Untitled page';
      const description = source.description || '';
      const canonical = source.canonical || direct(side, route);
      const siteName = source.siteName
        || config.brand
        || new URL(direct(side, route)).hostname;
      let canonicalPath = canonical;
      try { canonicalPath = new URL(canonical).pathname; } catch {}
      meta[side] = { title, description, canonicalPath, heading };
      statusDetails[side] = { ...statusDetails[side], ...(source.timing || {}) };
      label.querySelector('.page-heading').textContent = heading;
      label.querySelector('.page-heading').title = title || heading;
      updateDocTitle();
      const compactTitle = document.querySelector('[data-compact-title="' + side + '"]');
      compactTitle.textContent = heading;
      compactTitle.title = title || heading;
      const compactOrigin = document.querySelector('[data-compact-origin="' + side + '"]');
      compactOrigin.textContent = new URL(config[side]).host + route;
      compactOrigin.title = config[side] + route;
      label.querySelector('.origin').textContent = config[side] + route;
      const fav = label.querySelector('.favicon');
      setFavicon(fav, side, source.icon);
      const compactFav = document.querySelector('[data-compact-favicon="' + side + '"]');
      setFavicon(compactFav, side, source.icon);
      label.querySelector('.open-side').href = direct(side, route);
      const card = label.querySelector('.seo-card');
      const sourceRow = element('div', 'seo-source');
      const seoFavicon = element('img', 'seo-favicon');
      seoFavicon.alt = '';
      setFavicon(seoFavicon, side, source.icon);
      const sourceText = element('div');
      sourceText.append(
        element('div', 'seo-site', siteName),
        element('div', 'seo-url', crumb(canonical)),
      );
      sourceText.lastChild.dataset.seo = 'url';
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
        seoChecks(source.checks || []),
      );
      const fails = (source.checks || []).filter((check) => !check.ok).length;
      const flag = label.querySelector('.seo-flag');
      if (flag) {
        flag.hidden = fails === 0;
        flag.textContent = fails ? String(fails) : '';
        flag.title = fails ? fails + ' SEO check' + (fails === 1 ? '' : 's') + ' failing' : '';
      }
      renderMetaDiff();
    }

    function seoChecks(checks) {
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

    function positionSeoCard(details) {
      const summary = details.querySelector('summary');
      const card = details.querySelector('.seo-card');
      const rect = summary.getBoundingClientRect();
      // Cap to half the viewport so the two cards can't collide, and anchor each
      // card's right edge under its SEO button so it drops within its own pane.
      const width = Math.max(260, Math.min(420, (innerWidth - 32) / 2));
      card.style.width = width + 'px';
      const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8));
      card.style.left = left + 'px';
      card.style.top = Math.min(innerHeight - 120, rect.bottom + 8) + 'px';
    }

    function googleOpen() {
      return !!document.querySelector('.label details[open]');
    }

    function setGoogleOpen(open) {
      const all = document.querySelectorAll('.label details');
      for (const details of all) {
        if (open) details.setAttribute('open', '');
        else details.removeAttribute('open');
      }
      if (open) {
        requestAnimationFrame(() => {
          for (const details of document.querySelectorAll('.label details[open]')) positionSeoCard(details);
        });
      }
    }

    function updateLabels(route) {
      for (const side of ['dev', 'live']) {
        const label = document.querySelector('.label[data-label="' + side + '"]');
        label.querySelector('.pill').className = 'pill ' + side;
        label.querySelector('.pill').textContent = side.toUpperCase();
        label.querySelector('.page-heading').textContent = 'Loading…';
        document.querySelector('[data-compact-title="' + side + '"]').textContent = 'Loading…';
        document.querySelector('[data-compact-origin="' + side + '"]').textContent =
          new URL(config[side]).host + route;
        document.querySelector('[data-compact-favicon="' + side + '"]').removeAttribute('src');
        label.querySelector('.origin').textContent = config[side] + route;
        setFavicon(label.querySelector('.favicon'), side);
        label.querySelector('.open-side').href = direct(side, route);
        meta[side] = null;
        statusDetails[side] = {};
        clearStatusBadge(side);
      }
      renderMetaDiff();
    }

    function applyOrder() {
      order.forEach((side, index) => {
        const pane = document.querySelector('[data-pane="' + side + '"]');
        pane.style.order = String(index);
        pane.classList.toggle('overlay-top', index === 1);
        document.querySelector('.label[data-label="' + side + '"]').style.order = String(index);
      });
    }

    function go(value = routeInput.value) {
      const route = normalizeRoute(value);
      routeInput.value = route;
      updateLabels(route);
      frame('dev').src = proxied('dev', route);
      frame('live').src = proxied('live', route);
      const url = new URL(location.href);
      url.searchParams.set('path', route);
      history.replaceState(null, '', url);
    }

    function setSplit(percent) {
      const value = Math.max(15, Math.min(85, percent));
      root.style.setProperty('--split', value + '%');
      divider.setAttribute('aria-valuenow', String(Math.round(value)));
      localStorage.setItem('site-compare-split', String(value));
      setUrlParam('split', Math.round(value * 10) / 10);
    }

    // Overlay and diff are only legible if both panes scroll in lockstep, so
    // they force pixel-exact linked scrolling regardless of the user's toggle.
    function stacked() { return viewMode === 'overlay'; }
    function linked() { return syncScroll || stacked(); }
    function effScrollMode() { return stacked() ? 'exact' : scrollMode; }

    function applyFrameSettings(side) {
      framePost(side, 'settings', { linked: linked(), mirror: mirrorLinks });
    }

    function setLinkedScroll(sourceSide, requestedY) {
      const otherSide = sourceSide === 'dev' ? 'live' : 'dev';
      const sourceMax = frameState[sourceSide].max;
      const sourceY = Math.max(0, Math.min(sourceMax, requestedY));
      suppressScrollUntil[sourceSide] = Date.now() + 120;
      if (effScrollMode() === 'exact') {
        const sharedMax = Math.min(sourceMax, frameState[otherSide].max);
        const sharedY = Math.min(sharedMax, sourceY);
        suppressScrollUntil[otherSide] = Date.now() + 120;
        frameState[sourceSide].y = sharedY;
        frameState[otherSide].y = sharedY;
        framePost(sourceSide, 'scroll', { y: sharedY });
        framePost(otherSide, 'scroll', { y: sharedY });
      } else {
        frameState[sourceSide].y = sourceY;
        framePost(sourceSide, 'scroll', { y: sourceY });
        alignSide(sourceSide, otherSide);
      }
    }

    function alignSide(sourceSide, targetSide) {
      let targetY = frameState[sourceSide].y;
      if (effScrollMode() === 'ratio') {
        const sourceMax = frameState[sourceSide].max;
        const ratio = sourceMax ? frameState[sourceSide].y / sourceMax : 0;
        targetY = ratio * frameState[targetSide].max;
      }
      suppressScrollUntil[targetSide] = Date.now() + (effScrollMode() === 'exact' ? 120 : 600);
      frameState[targetSide].y = targetY;
      framePost(targetSide, 'scroll', { y: targetY });
    }

    function syncFrom(side, force = false) {
      if (!linked() || Date.now() < suppressScrollUntil[side]) return;
      if (!scrollOwner) scrollOwner = side;
      if (!force && scrollOwner !== side) return;
      if (effScrollMode() === 'exact') {
        alignSide(side, side === 'dev' ? 'live' : 'dev');
        return;
      }
      cancelAnimationFrame(scrollFrames[side]);
      scrollFrames[side] = requestAnimationFrame(() => {
        const otherSide = side === 'dev' ? 'live' : 'dev';
        alignSide(side, otherSide);
        for (const timer of settleTimers[side]) clearTimeout(timer);
        settleTimers[side] = [80, 240].map((delay) => setTimeout(() => {
          if (scrollOwner === side) alignSide(side, otherSide);
        }, delay));
      });
    }

    function markScrollOwner(side) {
      scrollOwner = side;
    }

    for (const side of ['dev', 'live']) {
      frame(side).addEventListener('load', () => {
        applyFrameSettings(side);
      });
    }

    function runFrameKey(key, side, message) {
      const lower = String(key).toLowerCase();
      if (lower === 'r') document.querySelector('[data-action="reload"]').click();
      else if (lower === 's') document.querySelector('[data-action="swap"]').click();
      else if (lower === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
      else if (lower === 'd') {
        if (viewMode === 'overlay' && overlayBlend === 'difference') setMode('split');
        else { setMode('overlay'); setOverlayBlend('difference'); }
      } else if (lower === '0') setSplit(50);
      else if (key === '/') { routeInput.focus(); routeInput.select(); }
      else if (linked()) {
        let next = null;
        if (key === 'ArrowDown') next = message.y + 44;
        if (key === 'ArrowUp') next = message.y - 44;
        if (key === 'PageDown' || (key === ' ' && !message.shift)) next = message.y + message.height * .85;
        if (key === 'PageUp' || (key === ' ' && message.shift)) next = message.y - message.height * .85;
        if (key === 'Home') next = 0;
        if (key === 'End') next = message.max;
        if (next !== null) {
          markScrollOwner(side);
          setLinkedScroll(side, next);
        }
      }
    }

    addEventListener('message', (event) => {
      const message = event.data || {};
      const side = message.side;
      if (!['dev', 'live'].includes(side)
        || (!config.hosted && event.origin !== config.frameOrigins[side])
        || message.source !== 'sitedrift-frame'
        || event.source !== frame(side).contentWindow) return;
      if (message.type === 'ready') {
        renderMetadata(side, message);
        fetchStatus(side, message.route || '/');
        applyFrameSettings(side);
      } else if (message.type === 'scroll') {
        frameState[side] = { y: Number(message.y) || 0, max: Number(message.max) || 0 };
        syncFrom(side);
      } else if (message.type === 'wheel') {
        const delta = message.mode === 1 ? message.delta * 18
          : message.mode === 2 ? message.delta * message.height : message.delta;
        markScrollOwner(side);
        setLinkedScroll(side, frameState[side].y + delta);
      } else if (message.type === 'navigate') {
        go(message.route);
      } else if (message.type === 'dismiss') {
        closePopovers();
      } else if (message.type === 'key') {
        runFrameKey(message.key, side, message);
      }
    });

    function closePopovers() {
      for (const details of document.querySelectorAll('details[open]')) details.removeAttribute('open');
      hideStatusPopover();
      if (notesOpen && !notesDocked()) setNotesOpen(false);
    }
    scrollButton.addEventListener('click', () => {
      syncScroll = !syncScroll;
      scrollButton.classList.toggle('active', syncScroll);
      saveBool('scroll', 'site-compare-scroll', syncScroll);
      for (const side of ['dev', 'live']) applyFrameSettings(side);
      renderSettings();
      if (syncScroll) syncFrom(focusSide, true);
    });
    function renderSetting(button, active, stateText) {
      button.classList.toggle('active', active);
      button.querySelector('.state').textContent = stateText;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    function renderSettings() {
      renderSetting(mobileButton, mobileMode, mobileMode ? 'On' : 'Off');
      renderSetting(mirrorButton, mirrorLinks, mirrorLinks ? 'On' : 'Off');
      renderSetting(scrollModeButton, scrollMode === 'exact', scrollMode === 'exact' ? 'Exact' : 'Proportional');
      scrollButton.title = syncScroll ? 'Locked scrolling is on' : 'Locked scrolling is off';
      scrollButton.setAttribute('aria-pressed', syncScroll ? 'true' : 'false');
    }
    function renderScrollMode() {
      document.querySelector('[data-scroll-label]').textContent =
        scrollMode === 'exact' ? 'Locked scroll' : 'Ratio scroll';
      renderSettings();
    }
    scrollModeButton.addEventListener('click', () => {
      scrollMode = scrollMode === 'exact' ? 'ratio' : 'exact';
      localStorage.setItem('site-compare-scroll-mode', scrollMode);
      setUrlParam('scrollMode', scrollMode);
      renderScrollMode();
      for (const side of ['dev', 'live']) applyFrameSettings(side);
      if (syncScroll) syncFrom(focusSide, true);
    });
    mirrorButton.addEventListener('click', () => {
      mirrorLinks = !mirrorLinks;
      saveBool('mirror', 'site-compare-mirror', mirrorLinks);
      for (const side of ['dev', 'live']) applyFrameSettings(side);
      renderSettings();
    });
    mobileButton.addEventListener('click', () => {
      mobileMode = !mobileMode;
      app.classList.toggle('mobile', mobileMode);
      localStorage.setItem('site-compare-mode', mobileMode ? 'mobile' : 'desktop');
      setUrlParam('mode', mobileMode ? 'mobile' : 'desktop');
      renderSettings();
    });
    function setOverlayAmount(value) {
      overlayAmount = Math.max(0, Math.min(100, Math.round(value)));
      root.style.setProperty('--overlay', (overlayAmount / 100).toFixed(3));
      for (const slider of overlaySliders) slider.value = String(overlayAmount);
      localStorage.setItem('site-compare-overlay-amount', String(overlayAmount));
      setUrlParam('overlayAmount', overlayAmount);
    }
    function renderModes() {
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
    function setMode(mode) {
      if (!['split', 'solo', 'overlay'].includes(mode)) mode = 'split';
      viewMode = mode;
      app.classList.toggle('solo', mode === 'solo');
      app.classList.toggle('overlay', mode === 'overlay');
      app.classList.toggle('diff', mode === 'overlay' && overlayBlend === 'difference');
      app.dataset.focus = focusSide;
      localStorage.setItem('site-compare-view', mode);
      setUrlParam('view', mode === 'split' ? null : mode);
      renderModes();
      applyOrder();
      // Overlay forces scroll-lock, so refresh scrollbar hiding + re-align.
      for (const side of ['dev', 'live']) applyFrameSettings(side);
      if (stacked()) alignSide(order[1], order[0]);
    }
    function setOverlayBlend(blend) {
      overlayBlend = blend === 'difference' ? 'difference' : 'opacity';
      app.classList.toggle('diff', viewMode === 'overlay' && overlayBlend === 'difference');
      localStorage.setItem('site-compare-overlay-blend', overlayBlend);
      setUrlParam('overlayBlend', overlayBlend === 'difference' ? 'difference' : null);
      renderModes();
    }
    for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
    for (const identity of document.querySelectorAll('.compact-side')) {
      identity.addEventListener('click', () => {
        if (viewMode !== 'solo') return;
        focusSide = identity.dataset.compactSide === 'dev' ? 'live' : 'dev';
        app.dataset.focus = focusSide;
        renderModes();
      });
    }
    for (const badge of document.querySelectorAll('.status-badge')) {
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

    function setCompact(value) {
      compactMode = value;
      app.classList.toggle('compact', compactMode);
      saveBool('compact', 'site-compare-compact', compactMode);
    }
    for (const button of document.querySelectorAll('[data-action="compact"]')) {
      button.addEventListener('click', () => setCompact(!compactMode));
    }

    function applyNotes(notes) {
      const list = Array.isArray(notes) ? notes : [];
      const signature = JSON.stringify(list);
      if (signature === notesSignature) return;
      notesSignature = signature;
      reviewNotes = list;
      renderNotes();
    }

    async function notesPull() {
      if (config.localNotes) {
        try { applyNotes(JSON.parse(localStorage.getItem(localNotesKey) || '[]')); } catch { applyNotes([]); }
        return;
      }
      try {
        const res = await fetch(config.api + '/notes', { cache: 'no-store', headers: apiHeaders });
        const data = await res.json();
        applyNotes(data.notes);
      } catch {}
    }

    async function notesPost(op) {
      if (config.localNotes) {
        let notes = [...reviewNotes];
        if (op.op === 'add') {
          notes.push({
            id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
            text: op.text,
            author: op.author,
            route: op.route,
            side: op.side || null,
            done: false,
            createdAt: new Date().toISOString(),
          });
        } else if (op.op === 'toggle') {
          notes = notes.map((note) => note.id === op.id ? { ...note, done: !note.done } : note);
        } else if (op.op === 'remove') {
          notes = notes.filter((note) => note.id !== op.id);
        } else if (op.op === 'clear') {
          notes = [];
        }
        localStorage.setItem(localNotesKey, JSON.stringify(notes));
        applyNotes(notes);
        return;
      }
      try {
        const res = await fetch(config.api + '/notes', {
          method: 'POST',
          headers: apiHeaders,
          body: JSON.stringify(op),
        });
        const data = await res.json();
        applyNotes(data.notes);
      } catch {}
    }

    function authorClass(name) {
      const who = String(name || '').toLowerCase();
      return who === 'joe' ? 'joe' : who === 'claude' ? 'claude' : 'other';
    }

    function renderNotes() {
      noteList.replaceChildren();
      for (const note of reviewNotes) {
        const item = document.createElement('li');
        if (note.done) item.classList.add('done');

        const metaRow = document.createElement('div');
        metaRow.className = 'note-meta';
        const who = document.createElement('span');
        who.className = 'note-author ' + authorClass(note.author);
        who.textContent = note.author || 'note';
        metaRow.append(who);
        const where = [note.side ? note.side.toUpperCase() : '', note.route && note.route !== '/' ? note.route : '']
          .filter(Boolean).join(' · ');
        if (where) {
          const tag = document.createElement('span');
          tag.className = 'note-where';
          tag.textContent = where;
          metaRow.append(tag);
        }
        item.append(metaRow);

        const text = document.createElement('div');
        text.className = 'note-text';
        text.textContent = note.text;
        if (note.route) {
          text.classList.add('note-go');
          text.title = 'Go to ' + note.route + (note.side ? ' · ' + note.side.toUpperCase() : '');
          text.addEventListener('click', () => {
            if (note.side) { focusSide = note.side; app.dataset.focus = focusSide; renderModes(); }
            go(note.route);
          });
        }
        item.append(text);

        const toggle = document.createElement('button');
        toggle.className = 'note-toggle';
        toggle.textContent = note.done ? '↺' : '✓';
        toggle.title = note.done ? 'Reopen note' : 'Mark done';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.addEventListener('click', () => notesPost({ op: 'toggle', id: note.id }));
        item.append(toggle);

        const copy = document.createElement('button');
        copy.className = 'note-copy';
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

        const remove = document.createElement('button');
        remove.className = 'remove-note';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove note');
        remove.addEventListener('click', () => notesPost({ op: 'remove', id: note.id }));
        item.append(remove);

        noteList.append(item);
      }
      const open = reviewNotes.filter((note) => !note.done).length;
      for (const count of document.querySelectorAll('[data-action="notes"] .count')) {
        count.textContent = String(open);
        count.style.display = open ? '' : 'none';
      }
    }

    const dockButton = document.querySelector('[data-action="notes-dock"]');
    function notesDocked() {
      return dockMode && innerWidth > 600;
    }
    function applyDock() {
      // Dock pushes the panes aside; float overlays them.
      app.classList.toggle('drawer-dock', notesOpen && notesDocked());
      dockButton.classList.toggle('active', dockMode);
      dockButton.setAttribute('aria-pressed', dockMode ? 'true' : 'false');
    }
    function setNotesOpen(value) {
      notesOpen = value;
      notesDrawer.classList.toggle('open', notesOpen);
      setUrlParam('notes', notesOpen ? '1' : '0');
      applyDock();
      if (notesOpen) noteInput.focus();
    }
    dockButton.addEventListener('click', () => {
      dockMode = !dockMode;
      saveBool('dock', 'site-compare-dock', dockMode);
      applyDock();
    });
    for (const button of document.querySelectorAll('[data-action="notes"]')) {
      button.addEventListener('click', () => setNotesOpen(!notesOpen));
    }
    document.querySelector('[data-action="notes-close"]').addEventListener('click', () => setNotesOpen(false));
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
      if (handled && (event.target === noteInput || event.target === routeInput)) event.target.blur();
    });
    // Auto-grow the compose box to its content (scroll past a cap), with a
    // floor the user can raise by dragging the top grip.
    const NOTE_MIN = 76;
    let noteFloor = NOTE_MIN;
    function autosizeNote() {
      const hardMax = Math.round(innerHeight * 0.6);
      noteInput.style.height = 'auto';
      const needed = noteInput.scrollHeight;
      const height = Math.min(hardMax, Math.max(NOTE_MIN, noteFloor, needed));
      noteInput.style.height = height + 'px';
      noteInput.style.overflowY = needed > height ? 'auto' : 'hidden';
    }
    noteInput.addEventListener('input', autosizeNote);
    const noteGrip = document.querySelector('.note-grip');
    noteGrip.addEventListener('pointerdown', (event) => {
      noteGrip.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startHeight = noteInput.offsetHeight;
      const onMove = (move) => {
        noteFloor = Math.max(NOTE_MIN, Math.min(Math.round(innerHeight * 0.6), startHeight + (startY - move.clientY)));
        autosizeNote();
      };
      const onUp = (up) => {
        noteGrip.releasePointerCapture(up.pointerId);
        noteGrip.removeEventListener('pointermove', onMove);
        noteGrip.removeEventListener('pointerup', onUp);
      };
      noteGrip.addEventListener('pointermove', onMove);
      noteGrip.addEventListener('pointerup', onUp);
    });
    document.querySelector('[data-action="note-add"]').addEventListener('click', () => {
      const text = noteInput.value.trim();
      if (!text) return;
      noteInput.value = '';
      autosizeNote();
      const side = viewMode === 'solo' ? focusSide : null;
      notesPost({ op: 'add', text, author: config.author || 'joe', route: routeInput.value, side });
    });
    noteInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        document.querySelector('[data-action="note-add"]').click();
      }
    });
    document.querySelector('[data-action="note-export"]').addEventListener('click', () => {
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
    const vaultButton = document.querySelector('[data-action="note-vault"]');
    if (config.vault) vaultButton.hidden = false;
    vaultButton.addEventListener('click', async () => {
      try {
        const res = await fetch(config.api + '/notes/save', { method: 'POST', headers: apiHeaders, body: '{}' });
        const data = await res.json();
        showToast(data.ok ? 'Saved to vault' : (data.error || 'Vault save failed'));
      } catch {
        showToast('Vault save failed');
      }
    });
    const localNotesNotice = document.querySelector('.local-notes-notice');
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

    document.querySelector('[data-action="go"]').addEventListener('click', () => go());
    for (const button of document.querySelectorAll('[data-action="reload"]')) {
      button.addEventListener('click', () => {
        for (const side of ['dev', 'live']) framePost(side, 'reload');
      });
    }
    for (const button of document.querySelectorAll('[data-action="swap"]')) {
      button.addEventListener('click', () => {
        if (viewMode === 'solo') {
          const nextSide = focusSide === 'dev' ? 'live' : 'dev';
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
      for (const details of document.querySelectorAll('details.settings[open], details.help[open]')) {
        if (!details.contains(event.target)) details.removeAttribute('open');
      }
      if (googleOpen() && !event.target.closest('.label')) setGoogleOpen(false);
      if (!statusPopover.hidden && !event.target.closest('.status-popover') && !event.target.closest('.status-badge')) {
        hideStatusPopover();
      }
      if (notesOpen && !notesDocked() && !event.target.closest('.review-drawer') && !event.target.closest('[data-action="notes"]')) {
        setNotesOpen(false);
      }
    });
    document.addEventListener('pointerup', (event) => {
      if (event.target.closest('input, textarea')) return;
      const control = event.target.closest('button, summary');
      if (control && control !== document.activeElement) return;
      control?.blur();
      getSelection()?.removeAllRanges();
    });
    addEventListener('resize', () => {
      hideStatusPopover();
      applyDock();
      for (const details of document.querySelectorAll('.label details[open]')) positionSeoCard(details);
    });
    routeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go();
    });
    addEventListener('keydown', (event) => {
      if (event.target === routeInput || event.target === noteInput) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'r') document.querySelector('[data-action="reload"]').click();
      if (event.key === 's') document.querySelector('[data-action="swap"]').click();
      if (event.key === 'o') setMode(viewMode === 'overlay' ? 'split' : 'overlay');
      if (event.key === 'd') {
        if (viewMode === 'overlay' && overlayBlend === 'difference') setMode('split');
        else { setMode('overlay'); setOverlayBlend('difference'); }
      }
      if (event.key === '0') setSplit(50);
      if (event.key === '/') { event.preventDefault(); routeInput.focus(); routeInput.select(); }
    });

    const initialSplit = Number(params.get('split') || localStorage.getItem('site-compare-split')) || 50;
    scrollButton.classList.toggle('active', syncScroll);
    renderScrollMode();
    app.classList.toggle('mobile', mobileMode);
    app.classList.toggle('compact', compactMode);
    app.dataset.focus = focusSide;
    setOverlayAmount(overlayAmount);
    renderSettings();
    notesDrawer.classList.toggle('open', notesOpen);
    applyDock();
    renderNotes();
    autosizeNote();
    setSplit(initialSplit);
    setMode(viewMode);
    go(params.get('path') || config.initialPath || '/');
    notesPull();
    if (!config.localNotes) setInterval(notesPull, 4000);
