// SciFlow Sharp Figures
// The editor renders each figure from a ~200px JPEG preview embedded in the document.
// SciFlow's GraphQL "document { files { id url } }" response lists the original file for
// each figure (file id == figure data-id). We read those responses as the app receives them
// and point the figure <img> at the original. Only the on-screen DOM is changed; the
// document model and what gets saved are untouched.
(() => {
  const files = new Map(); // figure id -> original URL

  function collectFiles(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => collectFiles(n, depth + 1)); return; }
    if (Array.isArray(node.files)) {
      for (const f of node.files) {
        if (f && f.id && typeof f.url === 'string' && (!f.type || f.type === 'image')) files.set(f.id, f.url);
      }
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectFiles(node[k], depth + 1);
  }

  // Original files live at .../files/<doc>/<hash>/<figureId>-<timestamp>.<ext>
  const FILE_RE = /(?:https:\/\/app\.sciflow\.net)?\/files\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/([A-Za-z0-9]+)-[0-9.]+\.(?:png|jpe?g|svg|gif|webp|tiff?|bmp)/gi;

  function ingest(text) {
    if (typeof text !== 'string' || text.length > 20e6) return;
    let found = false;
    if (text.includes('"files"')) {
      try { const before = files.size; collectFiles(JSON.parse(text)); found = files.size !== before || found; } catch (_) { /* not JSON */ }
    }
    if (text.includes('/files/')) {
      for (const m of text.replace(/\\\//g, '/').matchAll(FILE_RE)) {
        const url = m[0].startsWith('http') ? m[0] : 'https://app.sciflow.net' + m[0];
        if (files.get(m[1]) !== url) { files.set(m[1], url); found = true; }
      }
    }
    if (found || text.includes('"files"')) schedule();
  }

  const isSciflow = url => typeof url === 'string' && /sciflow\.net|^\//.test(url) && !/\/(log|stats)\b|session\/|\.(js|css|woff2?|svg|png)(\?|$)/.test(url);

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (isSciflow(url || res.url)) {
        const ct = res.headers.get('content-type') || '';
        if (/json|text/.test(ct)) res.clone().text().then(ingest, () => {});
      }
    } catch (_) {}
    return res;
  };

  // Hook XMLHttpRequest (SciFlow's GraphQL client and uploads use XHR).
  // We also remember SciFlow's own "WatchDocument" query so we can re-ask for the file list.
  let watchReq = null; // {method, url, headers, body}
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__sf = { method, url: String(url), headers: [] };
    if (isSciflow(this.__sf.url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') ingest(this.responseText);
          else if (this.responseType === 'json') ingest(JSON.stringify(this.response));
        } catch (_) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    this.__sf?.headers.push([k, v]);
    return origSetHeader.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__sf && !this.__sf.replay && typeof body === 'string' && body.includes('"WatchDocument"') && body.includes('files')) {
        watchReq = { ...this.__sf, body, withCredentials: this.withCredentials };
      }
    } catch (_) {}
    return origSend.call(this, body);
  };

  // Re-run WatchDocument when a figure on screen has no known original yet (e.g. just uploaded).
  let lastRefresh = 0, refreshTimer = null;
  const missingTries = new Map(); // figure id -> attempts
  function requestRefresh() {
    if (!watchReq || refreshTimer) return;
    const wait = Math.max(0, lastRefresh + 2500 - Date.now());
    refreshTimer = setTimeout(() => {
      refreshTimer = null; lastRefresh = Date.now();
      const x = new XMLHttpRequest();
      x.open(watchReq.method, watchReq.url);
      x.__sf.replay = true;
      x.withCredentials = !!watchReq.withCredentials;
      for (const [k, v] of watchReq.headers) x.setRequestHeader(k, v);
      x.send(watchReq.body);
    }, wait);
  }

  // Swap previews for originals
  const swaps = new WeakMap(); // img -> number of times we re-applied (loop guard)
  const previewMode = new Set(); // figure ids the user switched back to SciFlow's preview

  function setMode(wrap, sharp) {
    const id = wrap.getAttribute('data-id');
    const img = wrap.querySelector('sfin-figure .image-container img, sfin-figure img');
    if (sharp) {
      previewMode.delete(id);
      if (img) swaps.delete(img);
    } else {
      previewMode.add(id);
      if (img) {
        img.classList.remove('sf-sharp');
        img.parentElement?.querySelectorAll(':scope > .sf-handle').forEach(h => h.remove());
        img.style.removeProperty('--sf-w');
        img.classList.remove('sf-sized');
        if (img.dataset.sfPreview) img.setAttribute('src', img.dataset.sfPreview);
      }
    }
    apply();
  }

  function ensureButton(wrap, sharp) {
    const actions = wrap.querySelector('sfin-figure .actions');
    if (!actions) return;
    let btn = actions.querySelector(':scope > .sf-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sf-toggle';
      btn.contentEditable = 'false';
      // Keep the editor from moving the selection / starting a drag on this button.
      for (const ev of ['mousedown', 'pointerdown', 'dragstart']) {
        btn.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); });
      }
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        setMode(wrap, previewMode.has(wrap.getAttribute('data-id')));
      });
      actions.insertBefore(btn, actions.firstChild);
    }
    const label = sharp ? 'HD' : 'SD';
    const title = sharp ? 'Showing original image. Click to show SciFlow preview'
                        : 'Showing SciFlow preview. Click to show original image';
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.title !== title) btn.title = title;
    btn.classList.toggle('sf-on', sharp);
  }

  // ---- Drag-to-resize (display only; remembered per figure in this browser) ----
  const SIZE_KEY = 'sfSharpFigureWidths';
  const loadSizes = () => { try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || {}; } catch (_) { return {}; } };
  const saveSize = (id, w) => {
    try { const s = loadSizes(); if (w == null) delete s[id]; else s[id] = w; localStorage.setItem(SIZE_KEY, JSON.stringify(s)); } catch (_) {}
  };

  function applySize(img, id) {
    const w = loadSizes()[id];
    if (w) { img.style.setProperty('--sf-w', w + 'px'); img.classList.add('sf-sized'); }
    else { img.style.removeProperty('--sf-w'); img.classList.remove('sf-sized'); }
  }

  function startDrag(e, wrap, img, edge) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const id = wrap.getAttribute('data-id');
    const box = img.closest('.image') || img.parentElement.parentElement;
    const maxW = box.getBoundingClientRect().width;
    const startX = e.clientX, startW = img.getBoundingClientRect().width;
    const sign = edge === 'left' ? -1 : 1;
    // Image is centred, so each pixel the edge moves changes the width by two.
    const k = 2;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    document.documentElement.classList.add('sf-resizing');
    let w = startW;
    const move = ev => {
      ev.preventDefault();
      w = Math.round(Math.max(80, Math.min(maxW, startW + sign * k * (ev.clientX - startX))));
      img.style.setProperty('--sf-w', w + 'px');
      img.classList.add('sf-sized');
    };
    const up = ev => {
      ev.preventDefault(); ev.stopPropagation();
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('sf-resizing');
      saveSize(id, w);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function ensureHandles(wrap, img, sharp) {
    const cont = img.parentElement;
    if (!cont) return;
    const existing = cont.querySelectorAll(':scope > .sf-handle');
    if (!sharp) { existing.forEach(h => h.remove()); img.style.removeProperty('--sf-w'); img.classList.remove('sf-sized'); return; }
    cont.classList.add('sf-resizable');
    applySize(img, wrap.getAttribute('data-id'));
    // SciFlow has an .overlay element below the image, so pin the handles to the image box itself.
    if (!img.__sfRO) {
      const sync = () => {
        cont.style.setProperty('--sf-img-top', img.offsetTop + 'px');
        cont.style.setProperty('--sf-img-h', img.offsetHeight + 'px');
      };
      img.__sfRO = new ResizeObserver(sync);
      img.__sfRO.observe(img);
      img.addEventListener('load', sync);
      sync();
    }
    if (existing.length) return;
    for (const edge of ['left', 'right', 'corner']) {
      const h = document.createElement('div');
      h.className = 'sf-handle sf-handle-' + edge;
      h.contentEditable = 'false';
      h.title = 'Drag to resize (display only). Double-click to reset.';
      h.addEventListener('pointerdown', e => startDrag(e, wrap, img, edge));
      for (const ev of ['mousedown', 'dragstart', 'click']) h.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); });
      h.addEventListener('dblclick', e => {
        e.preventDefault(); e.stopPropagation();
        saveSize(wrap.getAttribute('data-id'), null);
        applySize(img, wrap.getAttribute('data-id'));
      });
      cont.appendChild(h);
    }
  }

  function apply() {
    for (const wrap of document.querySelectorAll('.figure-wrapper[data-id]')) {
      const id = wrap.getAttribute('data-id');
      const img = wrap.querySelector('sfin-figure .image-container img, sfin-figure img');
      // Image replaced? SciFlow puts a new preview in; the original we knew is now outdated.
      const cur0 = img?.getAttribute('src') || '';
      if (img && cur0.startsWith('data:') && img.dataset.sfPreview && cur0 !== img.dataset.sfPreview) {
        wrap.dataset.sfStale = files.get(id) || '';
        img.dataset.sfPreview = cur0;
        swaps.delete(img);
        missingTries.delete(id);
        img.classList.remove('sf-sharp');
      }
      let url = files.get(id);
      if (url && wrap.dataset.sfStale === url) url = undefined;
      else if (url && wrap.dataset.sfStale) delete wrap.dataset.sfStale;
      if (img && !url) {
        // Figure with an image but no known original: ask SciFlow for the file list again.
        const n = missingTries.get(id) || 0;
        if (n < 15) { missingTries.set(id, n + 1); requestRefresh(); setTimeout(schedule, 3000); }
      }
      if (!url || !img) continue;
      const sharp = !previewMode.has(id);
      ensureButton(wrap, sharp);
      ensureHandles(wrap, img, sharp);
      if (!sharp) continue;
      const cur = img.getAttribute('src');
      if (cur === url) continue;
      const n = (swaps.get(img) || 0) + 1;
      if (n > 20) continue; // something keeps resetting it; give up on this element
      swaps.set(img, n);
      if (cur && cur.startsWith('data:')) img.dataset.sfPreview = cur;
      img.classList.add('sf-sharp');
      img.setAttribute('src', url);
    }
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; apply(); });
  }

  const start = () => {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-id'],
    });
    schedule();
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);

  window.__sciflowSharpFigures = { files, apply, hasWatchReq: () => !!watchReq, missingTries };
})();
