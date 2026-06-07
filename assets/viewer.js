const config = window.__SITEDRIFT_CONFIG__;
    delete window.__SITEDRIFT_CONFIG__;
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
    const params = new URLSearchParams(location.search);
    const suppressScrollUntil = { dev: 0, live: 0 };
    const scrollFrames = { dev: 0, live: 0 };
    const settleTimers = { dev: [], live: [] };
    const frameState = { dev: { y: 0, max: 0 }, live: { y: 0, max: 0 } };
    let order = params.get('swap') === '1' ? ['live', 'dev'] : ['dev', 'live'];
    let syncScroll = queryOrStoredBool('scroll', 'site-compare-scroll', false);
    let scrollMode = params.get('scrollMode') || localStorage.getItem('site-compare-scroll-mode') || 'exact';
    if (!['exact', 'ratio'].includes(scrollMode)) scrollMode = 'exact';
    let mirrorLinks = queryOrStoredBool('mirror', 'site-compare-mirror', false);
    let mobileMode = (params.get('mode') || localStorage.getItem('site-compare-mode')) === 'mobile';
    let compactMode = queryOrStoredBool('compact', 'site-compare-compact', false);
    const storedView = localStorage.getItem('site-compare-view');
    let viewMode = params.get('view')
      || (params.get('overlay') === '1' ? 'overlay' : params.get('solo') === '1' ? 'solo' : null)
      || storedView
      || (innerWidth <= 600 ? 'solo' : 'split');
    let overlayBlend = (params.get('overlayBlend') || localStorage.getItem('site-compare-overlay-blend')) === 'difference' ? 'difference' : 'opacity';
    if (viewMode === 'diff') { viewMode = 'overlay'; overlayBlend = 'difference'; } // back-compat
    if (!['split', 'solo', 'overlay'].includes(viewMode)) viewMode = 'split';
    let overlayAmount = Number(params.get('overlayAmount') ?? localStorage.getItem('site-compare-overlay-amount'));
    if (!Number.isFinite(overlayAmount)) overlayAmount = 50;
    let focusSide = params.get('focus') === 'live' ? 'live' : params.get('focus') === 'dev' ? 'dev' : order[0];
    let reviewNotes = [];
    let notesSignature = '';
    let notesOpen = params.get('notes') === '1';
    let dockMode = queryOrStoredBool('dock', 'site-compare-dock', true);
    let scrollOwner = null;
    const meta = { dev: null, live: null };
    const apiHeaders = {
      authorization: 'Bearer ' + config.token,
      'content-type': 'application/json',
    };

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
    function proxied(side, route) { return config.frameOrigins[side] + '/__' + side + normalizeRoute(route); }
    function statusUrl(side, route) { return '/__' + side + normalizeRoute(route); }
    function direct(side, route) { return config[side] + normalizeRoute(route); }
    function framePost(side, type, data = {}) {
      frame(side).contentWindow?.postMessage({ source: 'sitedrift-parent', side, type, ...data }, config.frameOrigins[side]);
    }

    function statusBadges(side) {
      return [
        document.querySelector('.label[data-label="' + side + '"] .status-badge'),
        document.querySelector('[data-compact-side="' + side + '"] .status-badge'),
      ].filter(Boolean);
    }

    function setStatusBadge(side, status) {
      const cls = status >= 200 && status < 300 ? 'status-ok'
        : status >= 300 && status < 400 ? 'status-warn'
        : 'status-err';
      const text = status ? String(status) : 'ERR';
      for (const badge of statusBadges(side)) {
        badge.className = 'status-badge show ' + cls;
        badge.textContent = text;
      }
    }

    function clearStatusBadge(side) {
      for (const badge of statusBadges(side)) {
        badge.className = 'status-badge';
        badge.textContent = '';
      }
    }

    function fetchStatus(side, route) {
      const url = statusUrl(side, route);
      const read = (method) => fetch(url, { method, cache: 'no-store', redirect: 'manual' });
      read('HEAD')
        .then((res) => (res.status === 405 || res.status === 501 ? read('GET') : res))
        .then((res) => setStatusBadge(side, res.status || (res.type === 'opaqueredirect' ? 302 : 0)))
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

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[char]);
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
      const faviconSrc = source.icon || (config.frameOrigins[side] + '/__' + side + '/favicon.ico');
      let canonicalPath = canonical;
      try { canonicalPath = new URL(canonical).pathname; } catch {}
      meta[side] = { title, description, canonicalPath, heading };
      label.querySelector('.page-heading').textContent = heading;
      label.querySelector('.page-heading').title = title || heading;
      updateDocTitle();
      document.querySelector('[data-compact-title="' + side + '"]').textContent = heading;
      label.querySelector('.origin').textContent = config[side] + route;
      const fav = label.querySelector('.favicon');
      fav.onerror = () => { fav.onerror = null; fav.src = '/icon.svg'; };
      fav.src = faviconSrc;
      label.querySelector('.open-side').href = direct(side, route);
      label.querySelector('.seo-card').innerHTML =
        '<div class="seo-eyebrow">' + side.toUpperCase() + ' metadata preview</div>' +
        '<div class="seo-source">' +
          '<img class="seo-favicon" alt="" src="' + escapeHtml(faviconSrc) + '">' +
          '<div><div class="seo-site">' + escapeHtml(siteName) + '</div>' +
          '<div class="seo-url" data-seo="url">' + escapeHtml(crumb(canonical)) + '</div></div>' +
          '<div class="seo-menu" aria-hidden="true">⋮</div>' +
        '</div>' +
        '<div class="seo-title' + (title ? '' : ' seo-empty') + '" data-seo="title">' +
          escapeHtml(truncate(title || 'Missing page title', 62)) + '</div>' +
        '<div class="seo-description' + (description ? '' : ' seo-empty') + '" data-seo="desc">' +
          escapeHtml(truncate(description || 'Missing meta description', 158)) + '</div>' +
        seoChecksHtml(source.checks || []);
      const seoFav = label.querySelector('.seo-favicon');
      if (seoFav) seoFav.onerror = () => { seoFav.onerror = null; seoFav.src = '/icon.svg'; };
      const fails = (source.checks || []).filter((check) => !check.ok).length;
      const flag = label.querySelector('.seo-flag');
      if (flag) {
        flag.hidden = fails === 0;
        flag.textContent = fails ? String(fails) : '';
        flag.title = fails ? fails + ' SEO check' + (fails === 1 ? '' : 's') + ' failing' : '';
      }
      renderMetaDiff();
    }

    function seoChecksHtml(checks) {
      const fails = checks.filter((check) => !check.ok).length;
      const head = '<div class="seo-checks-head"><span>SEO checks</span>'
        + (fails
          ? '<span class="bad">' + fails + ' to fix</span>'
          : '<span class="good">all good</span>')
        + '</div>';
      const rows = checks.map((check) =>
        '<div class="seo-check ' + (check.ok ? 'ok' : 'bad') + '">'
        + '<span class="seo-check-mark">' + (check.ok ? '✓' : '✗') + '</span>'
        + '<span class="seo-check-label">' + escapeHtml(check.label) + '</span>'
        + (check.note ? '<span class="seo-check-note">' + escapeHtml(check.note) + '</span>' : '')
        + '</div>').join('');
      return '<div class="seo-checks">' + head + rows + '</div>';
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
        label.querySelector('.origin').textContent = config[side] + route;
        label.querySelector('.favicon').src = '/__' + side + '/favicon.ico';
        label.querySelector('.open-side').href = direct(side, route);
        meta[side] = null;
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
        || event.origin !== config.frameOrigins[side]
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
      } else if (message.type === 'key') {
        runFrameKey(message.key, side, message);
      }
    });

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
      try {
        const res = await fetch(config.api + '/notes', { cache: 'no-store', headers: apiHeaders });
        const data = await res.json();
        applyNotes(data.notes);
      } catch {}
    }

    async function notesPost(op) {
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
        copy.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5v5A1.5 1.5 0 0 1 14.5 12H12" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="8" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
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
    function applyDock() {
      // Dock pushes the panes aside; float overlays them.
      app.classList.toggle('drawer-dock', notesOpen && dockMode);
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
      link.href = '/notes.md';
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
    document.querySelector('[data-action="swap"]').addEventListener('click', () => {
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
      if (notesOpen && !dockMode && !event.target.closest('.review-drawer') && !event.target.closest('[data-action="notes"]')) {
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
    go(params.get('path') || '/');
    notesPull();
    setInterval(notesPull, 4000);
