(function (root) {
  'use strict';
  // Offline raster tile math, LRU cache, asynchronous tile loader and basemap switcher UI.
  // Pure functions are exported on both window.RelationshipRaster and module.exports for Node unit tests.

  const MAX_LAT = 85.0511287798;
  const MAX_CACHE_TILES = 300;
  const MAX_CACHE_BYTES = 64 * 1024 * 1024;
  const MAX_CONCURRENT = 8;
  const DEFAULT_TILE_BYTES = 256 * 256 * 4;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function normXY(lat, lng) {
    const la = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return {
      x: (lng + 180) / 360,
      y: 0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI),
    };
  }

  // Native zoom level to request from the tilepack: clamped to [minzoom, maxzoom].
  // Zooms above maxzoom (18..19) scale the maxzoom tile; zooms below minzoom fade out.
  function nativeZoom(z, minzoom = 11, maxzoom = 17) {
    return clamp(Math.round(Number(z) || 0), minzoom, maxzoom);
  }

  // Opacity of the raster layer: 1 at/above minzoom, fading smoothly to 0 below minzoom.
  function rasterAlpha(z, minzoom = 11) {
    const zv = Number(z) || 0;
    if (zv >= minzoom - 0.15) return 1;
    if (zv <= minzoom - 1.5) return 0;
    return round((zv - (minzoom - 1.5)) / 1.35, 3);
  }

  function latLngToTileXY(lat, lng, z) {
    const n = 2 ** z;
    const p = normXY(lat, lng);
    return {
      x: clamp(Math.floor(p.x * n), 0, n - 1),
      y: clamp(Math.floor(p.y * n), 0, n - 1),
    };
  }

  function tileRangeForBounds(bounds, z) {
    const nw = latLngToTileXY(bounds.n, bounds.w, z);
    const se = latLngToTileXY(bounds.s, bounds.e, z);
    return {
      minX: Math.min(nw.x, se.x),
      maxX: Math.max(nw.x, se.x),
      minY: Math.min(nw.y, se.y),
      maxY: Math.max(nw.y, se.y),
    };
  }

  function tileInBounds(z, x, y, bounds, rows) {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0) return false;
    const n = 2 ** z;
    if (x < 0 || x >= n || y < 0 || y >= n) return false;
    if (rows && rows[z]) {
      const yr = rows[z][y];
      if (!yr || x < yr[0] || x > yr[1]) return false;
    }
    if (!bounds) return true;
    const r = tileRangeForBounds(bounds, z);
    return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
  }

  // Computes the list of native tiles needed to cover a viewport, with screen positions and scale.
  function tilesForView({ lat, lng, z, width, height, minzoom = 11, maxzoom = 17, tileSize = 256, bounds = null, rows = null }) {
    if (!(width > 0 && height > 0) || rasterAlpha(z, minzoom) <= 0) return [];
    const nz = nativeZoom(z, minzoom, maxzoom);
    const scale = 2 ** (z - nz);
    const drawSize = tileSize * scale;
    const worldPx = tileSize * (2 ** z);
    const c = normXY(lat, lng);
    const ox = c.x * worldPx - width / 2;
    const oy = c.y * worldPx - height / 2;
    const nTiles = 2 ** nz;
    let x0 = Math.max(0, Math.floor(ox / drawSize));
    let x1 = Math.min(nTiles - 1, Math.floor((ox + width - 1e-9) / drawSize));
    let y0 = Math.max(0, Math.floor(oy / drawSize));
    let y1 = Math.min(nTiles - 1, Math.floor((oy + height - 1e-9) / drawSize));
    if (bounds) {
      const r = tileRangeForBounds(bounds, nz);
      x0 = Math.max(x0, r.minX);
      x1 = Math.min(x1, r.maxX);
      y0 = Math.max(y0, r.minY);
      y1 = Math.min(y1, r.maxY);
    }
    if (x0 > x1 || y0 > y1) return [];
    const out = [];
    const cx = width / 2, cy = height / 2;
    for (let ty = y0; ty <= y1; ty++) {
      let rx0 = x0, rx1 = x1;
      if (rows && rows[nz]) {
        const yr = rows[nz][ty];
        if (!yr) continue;
        rx0 = Math.max(rx0, yr[0]);
        rx1 = Math.min(rx1, yr[1]);
        if (rx0 > rx1) continue;
      }
      for (let tx = rx0; tx <= rx1; tx++) {
        const sx = tx * drawSize - ox;
        const sy = ty * drawSize - oy;
        const dist = Math.hypot(sx + drawSize / 2 - cx, sy + drawSize / 2 - cy);
        out.push({
          z: nz,
          x: tx,
          y: ty,
          key: `${nz}/${tx}/${ty}`,
          sx,
          sy,
          size: drawSize,
          scale,
          dist,
        });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // Finds the closest cached ancestor tile at z-1..z-maxSteps and returns the source sub-rectangle to draw.
  function parentFallback(z, x, y, hasTile, minzoom = 11, maxSteps = 3, tileSize = 256) {
    const check = typeof hasTile === 'function' ? hasTile : (k => Boolean(hasTile && (hasTile.has ? hasTile.has(k) : hasTile[k])));
    for (let dz = 1; dz <= maxSteps && z - dz >= minzoom; dz++) {
      const pz = z - dz;
      const factor = 2 ** dz;
      const px = Math.floor(x / factor);
      const py = Math.floor(y / factor);
      const key = `${pz}/${px}/${py}`;
      if (check(key)) {
        const sub = tileSize / factor;
        return {
          z: pz,
          x: px,
          y: py,
          key,
          dz,
          srcX: (x % factor) * sub,
          srcY: (y % factor) * sub,
          srcW: sub,
          srcH: sub,
        };
      }
    }
    return null;
  }

  // LRU cache of decoded tiles capped by both entry count and byte budget.
  function createLruCache(maxEntries = MAX_CACHE_TILES, maxBytes = MAX_CACHE_BYTES) {
    const map = new Map(); // key -> { value, bytes }
    let totalBytes = 0;

    function evictEntry(k, entry) {
      map.delete(k);
      totalBytes = Math.max(0, totalBytes - entry.bytes);
      if (entry.value && typeof entry.value.close === 'function') {
        try { entry.value.close(); } catch (_) { /* ignore */ }
      }
    }

    return {
      get(key) {
        const entry = map.get(key);
        if (!entry) return undefined;
        map.delete(key);
        map.set(key, entry);
        return entry.value;
      },
      set(key, value, bytes = DEFAULT_TILE_BYTES) {
        const sz = Math.max(1, Number(bytes) || DEFAULT_TILE_BYTES);
        if (map.has(key)) {
          const old = map.get(key);
          map.delete(key);
          totalBytes = Math.max(0, totalBytes - old.bytes);
          if (old.value && old.value !== value && typeof old.value.close === 'function') {
            try { old.value.close(); } catch (_) { /* ignore */ }
          }
        }
        while (map.size >= maxEntries || (map.size > 0 && totalBytes + sz > maxBytes)) {
          const oldestKey = map.keys().next().value;
          evictEntry(oldestKey, map.get(oldestKey));
        }
        map.set(key, { value, bytes: sz });
        totalBytes += sz;
        return value;
      },
      has(key) { return map.has(key); },
      delete(key) {
        const entry = map.get(key);
        if (!entry) return false;
        evictEntry(key, entry);
        return true;
      },
      clear() {
        for (const [k, entry] of [...map.entries()]) evictEntry(k, entry);
        totalBytes = 0;
      },
      get size() { return map.size; },
      get bytes() { return totalBytes; },
      keys() { return [...map.keys()]; },
    };
  }

  function builtinAreaFromInfo(info, bboxAreaKm2Fn) {
    if (!info || !info.available || !info.bounds) return null;
    const b = info.bounds;
    const center = { lat: round((b.s + b.n) / 2, 6), lng: round((b.w + b.e) / 2, 6) };
    const areaKm2 = typeof bboxAreaKm2Fn === 'function' ? bboxAreaKm2Fn(b) : round((b.n - b.s) * 110.574 * (b.e - b.w) * 111.32 * Math.cos(center.lat * Math.PI / 180), 1);
    const rawName = String(info.name || '').trim();
    const name = /gaza|غزة/i.test(rawName) ? 'منطقة غزة' : (rawName || 'منطقة الخريطة');
    return {
      name,
      rawName,
      center,
      sideKm: Math.min(50, Math.max(4, Math.round(Math.sqrt(areaKm2)))),
      bbox: { s: b.s, w: b.w, n: b.n, e: b.e },
      detail: 'medium',
      areaKm2,
      builtin: true,
    };
  }

  function resolveInitialBasemap({ saved, rasterAvailable, hasVector }) {
    if (!rasterAvailable) return 'vector';
    if (saved === 'vector' || saved === 'raster' || saved === 'hybrid') return saved;
    if (!hasVector) return 'raster';
    return 'vector';
  }

  function nextBasemap(current, rasterAvailable) {
    if (!rasterAvailable) return 'vector';
    const order = ['vector', 'raster', 'hybrid'];
    const idx = order.indexOf(current);
    return order[(idx + 1) % order.length];
  }

  function attributionFor(basemap, tileInfo) {
    const hasRaster = Boolean(tileInfo && tileInfo.available);
    const packAttr = (tileInfo && tileInfo.attribution) || '© OpenStreetMap contributors; basemap © European Commission / Eurostat GISCO';
    if (basemap === 'raster' && hasRaster) return packAttr;
    if (basemap === 'hybrid' && hasRaster) return `بيانات الخريطة © مساهمو OpenStreetMap · ${packAttr}`;
    return 'بيانات الخريطة © مساهمو OpenStreetMap';
  }

  function isRectOutsideView(rect, viewW, viewH, margin = 24) {
    if (!rect || !(viewW > 0 && viewH > 0)) return false;
    return rect.x + rect.w < margin || rect.x > viewW - margin || rect.y + rect.h < margin || rect.y > viewH - margin;
  }

  // ---- Browser controller (DOM + Canvas + fetch) ------------------------------------------------------
  const THUMB = {
    vector: '<svg class="geo-bm-thumb" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="4" fill="#101923"/><path d="M2 15L12 5l7 7 7-8" stroke="#5d7898" stroke-width="2.2" fill="none"/><path d="M0 9h28M15 0v20" stroke="#2b3645" stroke-width="1.3"/><circle cx="19" cy="12" r="2.2" fill="#cdfe64"/></svg>',
    raster: '<svg class="geo-bm-thumb" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="4" fill="#eae5dc"/><path d="M0 0L10 0L0 14Z" fill="#9ec7e2"/><rect x="9" y="3" width="6" height="5" rx="1" fill="#d3cabd"/><rect x="17" y="4" width="7" height="5" rx="1" fill="#d3cabd"/><rect x="10" y="11" width="8" height="6" rx="1" fill="#d3cabd"/><path d="M4 18L24 2" stroke="#f2b866" stroke-width="2.4"/></svg>',
    hybrid: '<svg class="geo-bm-thumb" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="4" fill="#eae5dc"/><path d="M0 0L14 0L14 20L0 20Z" fill="#101923"/><path d="M2 16L13 5L26 14" stroke="#cdfe64" stroke-width="2" fill="none"/><circle cx="14" cy="10" r="2.3" fill="#ff7a6b"/></svg>',
  };

  function switcherHtml() {
    return `<div class="geo-basemap-bar" id="geo-basemap-bar">
      <div class="geo-basemap-switch" id="geo-basemap-switch" role="group" aria-label="نوع الخريطة الأساسية">
        <button type="button" data-basemap="vector" aria-pressed="false" title="خريطة الشوارع المتجهة (B)">${THUMB.vector}<span>خريطة الشوارع</span></button>
        <button type="button" data-basemap="raster" aria-pressed="false" title="الخريطة المحمّلة — خريطة المباني والمعالم التفصيلية (B)">${THUMB.raster}<span>الخريطة المحمّلة</span></button>
        <button type="button" data-basemap="hybrid" aria-pressed="false" title="مدمجة — الخريطة المحمّلة مع طبقة الشوارع والتسميات (B)">${THUMB.hybrid}<span>مدمجة</span></button>
      </div>
      <label class="geo-hybrid-slider" id="geo-hybrid-wrap" hidden title="شفافية طبقة الشوارع فوق الخريطة المحمّلة">
        <span>الشفافية</span>
        <input type="range" id="geo-hybrid-alpha" min="15" max="100" step="5" value="75" aria-label="شفافية طبقة الشوارع">
      </label>
    </div>`;
  }

  function layersSectionHtml() {
    return `<div class="geo-layers-sec">
      <strong class="geo-layers-heading">الخريطة الأساسية <kbd>B</kbd></strong>
      <div class="geo-layers-bm" role="group" aria-label="اختيار الخريطة الأساسية">
        <button type="button" data-basemap="vector" aria-pressed="false">خريطة الشوارع</button>
        <button type="button" data-basemap="raster" aria-pressed="false">الخريطة المحمّلة</button>
        <button type="button" data-basemap="hybrid" aria-pressed="false">مدمجة</button>
      </div>
      <label class="geo-layers-range" id="geo-layers-hybrid-wrap" hidden>
        <span>شفافية طبقة الشوارع</span>
        <input type="range" id="geo-layers-hybrid-alpha" min="15" max="100" step="5" value="75" aria-label="شفافية طبقة الشوارع في الوضع المدمج">
      </label>
    </div>`;
  }

  function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = err => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  function createController({ G, M, el, schedule, fitArea, openSetup, lsGet, lsSet }) {
    const cache = createLruCache(MAX_CACHE_TILES, MAX_CACHE_BYTES);
    const missing = new Set();
    const inFlight = new Map(); // key -> { ctrl, z, x, y, pinned }
    let queue = [];
    let infoLoaded = false;
    let infoLoading = null;

    M.tileInfo = { available: false, name: '', bounds: null, minzoom: 11, maxzoom: 17, tileSize: 256, attribution: '' };
    M.savedBasemap = lsGet('relationship-map-geo-basemap', null);
    M.basemap = M.savedBasemap || 'vector';
    M.hybridOpacity = clamp(Number(lsGet('relationship-map-geo-hybrid-opacity', 75)) || 75, 15, 100);
    if (M.layers.dimOutside === undefined) M.layers.dimOutside = true;

    function setBasemap(mode, persist = true) {
      const avail = Boolean(M.tileInfo && M.tileInfo.available);
      if ((mode === 'raster' || mode === 'hybrid') && !avail) mode = 'vector';
      if (!['vector', 'raster', 'hybrid'].includes(mode)) mode = avail && !M.base ? 'raster' : 'vector';
      M.basemap = mode;
      if (persist) {
        M.savedBasemap = mode;
        lsSet('relationship-map-geo-basemap', mode);
      }
      syncUI();
      schedule();
    }

    function cycleBasemap() {
      const avail = Boolean(M.tileInfo && M.tileInfo.available);
      if (!avail) return;
      setBasemap(nextBasemap(M.basemap, avail), true);
    }

    function setHybridOpacity(val) {
      M.hybridOpacity = clamp(Number(val) || 75, 15, 100);
      lsSet('relationship-map-geo-hybrid-opacity', M.hybridOpacity);
      syncUI();
      schedule();
    }

    function syncUI() {
      if (!el.frame) return;
      const avail = Boolean(M.tileInfo && M.tileInfo.available);
      const isLight = avail && (M.basemap === 'raster' || M.basemap === 'hybrid') && rasterAlpha(M.z, M.tileInfo.minzoom || 11) > 0.35;
      el.frame.dataset.basemap = M.basemap;
      el.frame.classList.toggle('is-light-map', isLight);

      const unavailHint = 'ملف الخريطة غير موجود على هذا الجهاز';
      const vecTitle = M.base
        ? 'خريطة الشوارع المتجهة (تعمل دون اتصال)'
        : 'خريطة الشوارع المتجهة — لم تُنزَّل بيانات الشوارع بعد؛ اضغط لتحديد المنطقة أو تنزيلها';

      el.frame.querySelectorAll('[data-basemap]').forEach(btn => {
        const bm = btn.dataset.basemap;
        const on = bm === M.basemap;
        btn.setAttribute('aria-pressed', String(on));
        if (bm === 'raster' || bm === 'hybrid') {
          btn.disabled = !avail;
          btn.setAttribute('aria-disabled', String(!avail));
          btn.title = avail
            ? (bm === 'raster' ? 'الخريطة المحمّلة — خريطة المباني والمعالم التفصيلية (B)' : 'مدمجة — الخريطة المحمّلة مع طبقة الشوارع والتسميات (B)')
            : unavailHint;
        } else {
          btn.disabled = false;
          btn.removeAttribute('aria-disabled');
          // «قيد التجهيز» while the street map is missing (preparing, downloading, or failed and waiting for a retry).
          const preparing = !M.base;
          btn.title = preparing ? 'خريطة الشوارع — قيد التجهيز' : vecTitle;
          btn.dataset.preparing = preparing ? 'true' : 'false';
          const span = btn.querySelector('span');
          if (span) span.textContent = preparing ? 'خريطة الشوارع · قيد التجهيز' : 'خريطة الشوارع';
        }
      });

      const showSlider = avail && M.basemap === 'hybrid';
      const hw1 = el.frame.querySelector('#geo-hybrid-wrap');
      const hw2 = el.frame.querySelector('#geo-layers-hybrid-wrap');
      if (hw1) hw1.hidden = !showSlider;
      if (hw2) hw2.hidden = !showSlider;
      const r1 = el.frame.querySelector('#geo-hybrid-alpha');
      const r2 = el.frame.querySelector('#geo-layers-hybrid-alpha');
      if (r1 && Number(r1.value) !== M.hybridOpacity) r1.value = String(M.hybridOpacity);
      if (r2 && Number(r2.value) !== M.hybridOpacity) r2.value = String(M.hybridOpacity);

      if (el.attrib) {
        el.attrib.hidden = false;
        el.attrib.textContent = attributionFor(M.basemap, M.tileInfo);
      }

      if (el.areaPill) {
        if (M.area) {
          const areaLabel = M.area.name || 'منطقة العمل';
          const km2 = M.area.areaKm2 || G.bboxAreaKm2(M.area.bbox);
          el.areaPill.hidden = false;
          el.areaText.textContent = `${areaLabel} · ${km2} كم²`;
        } else {
          el.areaPill.hidden = true;
        }
      }
    }

    function pumpQueue() {
      while (inFlight.size < MAX_CONCURRENT && queue.length) {
        const item = queue.shift();
        if (!item || cache.has(item.key) || missing.has(item.key) || inFlight.has(item.key)) continue;
        startFetch(item);
      }
    }

    function startFetch(item) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const rec = { ...item, ctrl };
      inFlight.set(item.key, rec);
      fetch(`/api/tiles/${item.z}/${item.x}/${item.y}.webp`, {
        credentials: 'same-origin',
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(async res => {
          if (res.status === 404) {
            missing.add(item.key);
            return;
          }
          if (!res.ok) return;
          const blob = await res.blob();
          const bmp = await decodeBlob(blob);
          cache.set(item.key, bmp, Math.max(DEFAULT_TILE_BYTES, blob.size * 4));
          schedule();
        })
        .catch(() => { /* aborted or offline */ })
        .finally(() => {
          inFlight.delete(item.key);
          pumpQueue();
        });
    }

    function cancelNonVisible(visibleKeys) {
      queue = queue.filter(q => q.pinned || visibleKeys.has(q.key));
      for (const [k, rec] of [...inFlight.entries()]) {
        if (!rec.pinned && !visibleKeys.has(k)) {
          if (rec.ctrl) { try { rec.ctrl.abort(); } catch (_) { /* ignore */ } }
          inFlight.delete(k);
        }
      }
    }

    function prefetchMinZoom() {
      const info = M.tileInfo;
      if (!info || !info.available || !info.bounds) return;
      const mz = info.minzoom || 11;
      const r = tileRangeForBounds(info.bounds, mz);
      for (let y = r.minY; y <= r.maxY; y++) {
        for (let x = r.minX; x <= r.maxX; x++) {
          if (!tileInBounds(mz, x, y, info.bounds, info.rows)) continue;
          const key = `${mz}/${x}/${y}`;
          if (!cache.has(key) && !missing.has(key) && !inFlight.has(key)) {
            queue.push({ z: mz, x, y, key, dist: 0, pinned: true });
          }
        }
      }
      pumpQueue();
    }

    async function ensureInfo(force = false) {
      if (infoLoaded && !force) return M.tileInfo;
      if (infoLoading) return infoLoading;
      infoLoading = (async () => {
        try {
          const r = await fetch('/api/tiles/info', { credentials: 'same-origin', cache: 'no-store' });
          if (r.status === 401) return M.tileInfo; // retry after sign-in
          if (!r.ok) throw new Error('status ' + r.status);
          const data = await r.json();
          infoLoaded = true;
          M.tileInfo = {
            available: Boolean(data && data.available),
            name: String((data && data.name) || ''),
            bounds: (data && data.bounds) || null,
            minzoom: Number(data && data.minzoom) || 11,
            maxzoom: Number(data && data.maxzoom) || 17,
            tileSize: Number(data && data.tileSize) || 256,
            attribution: String((data && data.attribution) || ''),
            rows: (data && data.rows) || null,
          };
          if (M.tileInfo.available && M.tileInfo.bounds) {
            M.builtinArea = builtinAreaFromInfo(M.tileInfo, G.bboxAreaKm2);
            if (!M.area) {
              M.area = M.builtinArea;
              M.positioned = false;
            }
            prefetchMinZoom();
          }
          const target = resolveInitialBasemap({
            saved: M.savedBasemap,
            rasterAvailable: M.tileInfo.available,
            hasVector: Boolean(M.base),
          });
          setBasemap(target, false);
          return M.tileInfo;
        } catch (_) {
          // Offline or static server: keep current state
          syncUI();
          return M.tileInfo;
        } finally {
          infoLoading = null;
        }
      })();
      return infoLoading;
    }

    function drawRaster(ctx) {
      const info = M.tileInfo;
      if (!info || !info.available || (M.basemap !== 'raster' && M.basemap !== 'hybrid')) return false;
      const alpha = rasterAlpha(M.z, info.minzoom);
      if (alpha <= 0) return false;

      const list = tilesForView({
        lat: M.lat,
        lng: M.lng,
        z: M.z,
        width: M.w,
        height: M.h,
        minzoom: info.minzoom,
        maxzoom: info.maxzoom,
        tileSize: info.tileSize || 256,
        bounds: info.bounds,
        rows: info.rows || null,
      });
      const visibleKeys = new Set(list.map(t => t.key));
      cancelNonVisible(visibleKeys);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const maxSteps = Math.max(3, (info.maxzoom || 17) - (info.minzoom || 11));
      for (const t of list) {
        const x0 = Math.round(t.sx), y0 = Math.round(t.sy);
        const x1 = Math.round(t.sx + t.size), y1 = Math.round(t.sy + t.size);
        const w = x1 - x0, h = y1 - y0;
        const img = cache.get(t.key);
        if (img) {
          ctx.drawImage(img, x0, y0, w, h);
        } else {
          const pf = parentFallback(t.z, t.x, t.y, k => cache.has(k), info.minzoom, maxSteps, info.tileSize || 256);
          if (pf) {
            const pImg = cache.get(pf.key);
            if (pImg) {
              ctx.drawImage(pImg, pf.srcX, pf.srcY, pf.srcW, pf.srcH, x0, y0, w, h);
            }
          }
          if (!missing.has(t.key) && !inFlight.has(t.key) && !queue.some(q => q.key === t.key)) {
            queue.push(t);
          }
        }
      }
      ctx.restore();
      pumpQueue();
      return alpha >= 0.99;
    }

    function drawAreaFrame(ctx, rect) {
      if (!rect) return;
      const { x, y, w, h } = rect;
      if (M.layers.dimOutside !== false) {
        ctx.save();
        ctx.fillStyle = 'rgba(6, 10, 15, 0.45)';
        ctx.beginPath();
        ctx.rect(0, 0, M.w, M.h);
        ctx.rect(x, y, w, h);
        ctx.fill('evenodd');
        ctx.restore();
      }
      if (M.layers.area !== false) {
        ctx.save();
        ctx.strokeStyle = 'rgba(10, 15, 21, 0.88)';
        ctx.lineWidth = 4.2;
        ctx.setLineDash([]);
        ctx.strokeRect(x, y, w, h);
        ctx.strokeStyle = '#cdfe64';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([9, 6]);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }
    }

    function wireControls() {
      if (!el.frame) return;
      el.frame.addEventListener('click', e => {
        const bmBtn = e.target.closest('[data-basemap]');
        if (bmBtn) {
          if (bmBtn.disabled) return;
          setBasemap(bmBtn.dataset.basemap, true);
          return;
        }
        const setupBtn = e.target.closest('[data-geo-open-setup]');
        if (setupBtn && !setupBtn.dataset.g) {
          openSetup();
        }
      });
      ['#geo-hybrid-alpha', '#geo-layers-hybrid-alpha'].forEach(sel => {
        const inp = el.frame.querySelector(sel);
        if (inp) inp.addEventListener('input', () => setHybridOpacity(inp.value));
      });
      document.addEventListener('keydown', e => {
        if ((e.key.toLowerCase() !== 'b' && e.code !== 'KeyB') || e.ctrlKey || e.metaKey || e.altKey) return;
        if (M.view === 'graph') return;
        const t = e.target, tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || document.querySelector('.ev-modal.open,.confirm-modal,#phase4-modal.open,#editor-modal.open')) return;
        e.preventDefault();
        cycleBasemap();
      });
    }

    return {
      ensureInfo,
      setBasemap,
      cycleBasemap,
      setHybridOpacity,
      syncUI,
      drawRaster,
      drawAreaFrame,
      wireControls,
      cache,
      _missing: missing,
    };
  }

  const api = {
    MAX_CACHE_TILES,
    MAX_CACHE_BYTES,
    MAX_CONCURRENT,
    normXY,
    nativeZoom,
    rasterAlpha,
    latLngToTileXY,
    tileRangeForBounds,
    tileInBounds,
    tilesForView,
    parentFallback,
    createLruCache,
    builtinAreaFromInfo,
    resolveInitialBasemap,
    nextBasemap,
    attributionFor,
    isRectOutsideView,
    switcherHtml,
    layersSectionHtml,
    createController,
    esc,
  };
  root.RelationshipRaster = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
