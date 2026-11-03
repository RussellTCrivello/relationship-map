(function () {
  'use strict';
  // Geographic map view. Integrates with the relationship graph (selection is shared) and works offline:
  // the basemap is a compact vector extract of OpenStreetMap for ONE configured area (default 20x20 km),
  // downloaded once and kept in IndexedDB. Locations live in node.geo (see geo.js).
  const G = window.RelationshipGeo;
  const R = window.RelationshipRaster;
  const IO = window.RelationshipGeoIO;
  const Download = window.RelationshipGeoDownload;
  const AreaStore = window.RelationshipGeoAreaStore;
  let manualAreaDownload = null;
  const C = window.RelationshipChronology;
  const H = () => window.RelationshipHost;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const safeUrl = u => (/^https?:\/\/\S+$/i.test(String(u || '').trim()) ? String(u).trim() : '');
  const ICON = {
    pin: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/></svg>',
    plus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    fit: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg>',
    area: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16" opacity=".5"/></svg>',
    zone: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8l7-5 9 4v9l-8 5-8-4z"/><circle cx="4" cy="8" r="1"/><circle cx="20" cy="16" r="1"/></svg>',
    search: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
    filter: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
    ruler: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17L17 3l4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2"/></svg>',
    layers: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" opacity=".9"/></svg>',
    gear: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>',
    graph: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8.2 8l3 7.9M16 8.2l-3 7.6M8.4 7h7.2"/></svg>',
    split: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></svg>',
    map: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"/></svg>',
    chev: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    image: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4 17l5-5 4 4 3-3 4 4"/></svg>',
  };

  // ---- storage (IndexedDB; falls back to memory) ------------------------------------------------------
  const mem = new Map();
  let dbp = null;
  const idb = () => (dbp = dbp || new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') { rej(new Error('no idb')); return; }
    const r = indexedDB.open('relationship-map-geo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  async function kvGet(k) {
    try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (_) { return mem.get(k); }
  }
  async function kvSet(k, v) {
    mem.set(k, v);
    try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (_) { /* memory only */ }
  }
  async function kvBatch(writes, deletes) {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite'), store = t.objectStore('kv');
      for (const [key, value] of writes) store.put(value, key);
      for (const key of deletes) store.delete(key);
      t.oncomplete = resolve; t.onerror = () => reject(t.error || new Error('تعذر حفظ المناطق.')); t.onabort = () => reject(t.error || new Error('تعذر حفظ المناطق.'));
    });
    for (const [key, value] of writes) mem.set(key, value);
    for (const key of deletes) mem.delete(key);
  }
  const areaStore = AreaStore.createStore({ get: kvGet, batch: kvBatch }, G);
  const freshAreaId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  async function reloadAreaList() {
    const loaded = await areaStore.load(M.builtinArea);
    M.areas = loaded.areas; M.activeAreaId = loaded.activeId;
    return loaded;
  }
  async function switchWorkingArea(id) {
    const result = await areaStore.switchArea(id);
    M.activeAreaId = id; M.area = result.area; M.base = result.base ? G.inflate(result.base) : null;
    M.positioned = false; resize(); if (M.w) { M.positioned = true; initialPosition(); }
    if (!M.base && !M.area.builtin) setVectorStatus('missing-area', 'لم تُنزَّل خريطة هذه المنطقة بعد.');
    else setVectorStatus(M.base ? 'ready' : 'idle', '');
    if (raster) raster.syncUI(); schedule(); updateHud(); renderCard();
  }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* optional */ } };

  // ---- state ------------------------------------------------------------------------------------------
  // Label classes understood by the renderer.
  const LABEL_CLASS_KEYS = ['admin', 'city', 'hood', 'landmark', 'green', 'water'];
  // One toggle per label class in the layers popover (1B.2). Parks and water share a single toggle, as asked.
  const LABEL_TOGGLES = [
    { k: 'admin', label: 'المناطق الإدارية', classes: ['admin'] },
    { k: 'city', label: 'المدن والبلدات', classes: ['city'] },
    { k: 'hood', label: 'الأحياء', hint: 'والأحياء والمخيمات', classes: ['hood'] },
    { k: 'landmark', label: 'المعالم والمرافق', classes: ['landmark'] },
    { k: 'parks', label: 'المتنزهات والمياه', classes: ['green', 'water'] },
  ];
  const toggleIsOn = t => t.classes.every(c => M.labelClasses[c] !== false);
  const DEFAULT_LABEL_CLASSES = Object.freeze({
    admin: true,
    city: true,
    hood: true,
    landmark: true,
    green: true,
    water: true,
  });

  const defaultFilters = () => ({ kinds: { entity: true, 'shared-event': true, 'personal-event': true, routes: true, zones: true }, eventTypes: [], entityTypes: [], from: '', to: '' });
  function loadFilters() {
    const raw = lsGet('relationship-map-geo-filters', {}), def = defaultFilters();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
    for (const k of Object.keys(def.kinds)) if (raw.kinds && raw.kinds[k] === false) def.kinds[k] = false;
    for (const k of ['eventTypes', 'entityTypes']) if (Array.isArray(raw[k])) def[k] = raw[k].filter(x => typeof x === 'string').slice(0, 100);
    for (const k of ['from', 'to']) if (/^\d{4}-\d{2}-\d{2}$/.test(raw[k] || '')) def[k] = raw[k];
    return def;
  }
  const filterCount = f => Object.values(f.kinds).filter(x => !x).length + (f.eventTypes.length ? 1 : 0) + (f.entityTypes.length ? 1 : 0) + (f.from ? 1 : 0) + (f.to ? 1 : 0);

  const M = {
    view: 'graph', area: null, builtinArea: null, areas: [], activeAreaId: 'gaza', areaStorageReady: false, initializing: true, base: null, tileInfo: null, basemap: 'vector', hybridOpacity: 75,
    lat: 39.5, lng: -98.35, z: 3, w: 0, h: 0, dpr: 1,
    layers: Object.assign({ roads: true, water: true, green: true, labels: true, area: true, dimOutside: true, pins: true, journey: false, zones: true }, lsGet('relationship-map-geo-layers', {})),
    // 1B.2: «لغة الأسماء» (ar | en | both) and one toggle per label class, both persisted in localStorage.
    labelLang: (() => { const v = lsGet('relationship-map-geo-label-lang', 'ar'); return ['ar', 'en', 'both'].includes(v) ? v : 'ar'; })(),
    labelClasses: Object.assign({ ...DEFAULT_LABEL_CLASSES }, lsGet('relationship-map-geo-label-classes', {})),
    hybridHideRasterClasses: lsGet('relationship-map-geo-hybrid-hide', true) !== false,
    // 1B.3: automatic vector map installation state.
    vectorStatus: 'idle', // idle | preparing | downloading | ready | missing-server | offline | error | outdated
    vectorHash: '', vectorNote: '', vectorProgress: '', vectorAttempts: 0,
    activeZone: null, zoneDraw: null, zoneEdit: null, zoneEditBase: null, zoneVertex: 0, filters: loadFilters(), time: { cursor: null, range: null, mode: 'cumulative', months: 12, speed: 1, playing: false, raf: 0, last: 0, fraction: 0, pulses: new Map() }, selected: null, activeEvent: null, hideCard: null, photoIdx: 0, pick: null, measure: null, cursor: null, raf: 0, pinEls: new Map(), positioned: false, fly: 0,
  };
  const MAX_Z = 19;
  let el = {}, raster = null;

  const hostState = () => H().state;
  const nodeById = id => hostState().byId.get(String(id));
  const colorOf = n => (n.schema === 'Event' && C ? C.typeInfo(n.eventType).color : H().schemaColor(n.schema)) || '#9aa6b6';
  const typeLabelOf = n => (n.schema === 'Event' && C ? C.typeLabel(n.eventType) : (H().TYPE_AR || {})[n.schema] || n.schema || 'كيان');
  const initialOf = n => (n.schema === 'Event' ? '⚑' : [...String(H().labelOf(n) || '•')][0] || '•');
  const allPins = () => {
    const h = hostState(), f = h.profileFilters || {}, hasGraphFilter = Boolean(String(h.search || '').trim()) || h.schema !== 'all' || !!(f.role || f.marital || f.health || f.family || f.minAge || f.maxAge);
    if (hasGraphFilter && h.matchIds && h.matchIds.size === 0) return [];
    return G.collectMapPins(h.nodes, h.matchIds);
  };
  const pins = () => {
    const all = allPins(); updateTimeBounds(all);
    const visible = G.filterMapPins(all, M.filters, C.dateRange);
    if (!M.time.range || M.time.cursor === null) return visible;
    const day = dayString(M.time.cursor);
    return visible.filter(p => p.kind === 'entity' || G.eventVisibleAtDate(p.kind === 'personal-event' ? p.event : p.node, day, M.time.mode, M.time.months, C.dateRange));
  };
  const pinByKey = key => pins().find(p => p.key === key);
  const pinTitle = p => p.kind === 'personal-event' ? String(p.event.title || 'حدث') : H().labelOf(p.node);
  const pinColor = p => p.kind === 'personal-event' ? C.typeInfo(p.event.type).color : colorOf(p.node);
  const pinCover = p => G.coverOf(p.kind === 'personal-event' ? null : p.node, p.geo);
  const minZoom = () => (M.area && M.w ? Math.max(2, G.fitZoom(M.area.bbox, M.w, M.h, 0) - 3) : 2);

  // ---- view switching (graph | map | split) -----------------------------------------------------------
  function setView(v) {
    if (!['graph', 'map', 'split'].includes(v)) v = 'graph';
    if (v === 'graph' && (M.pick || M.zoneDraw || M.zoneEdit || M.measure)) { toolBusyNotice(); return; }
    M.view = v; lsSet('relationship-map-view', v);
    $('#workspace').dataset.view = v; el.views.dataset.view = v;
    $$('#view-switch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    if (v !== 'graph') {
      requestAnimationFrame(() => {
        resize(); sync();
        // First visit after signing in: make sure the street map is being prepared (silently).
        if (!M.initializing && !M.base && (!M.area || M.area.builtin) && M.vectorStatus !== 'preparing' && M.vectorStatus !== 'downloading') autoInstallVectorMap();
      });
    }
  }
  const mapVisible = () => M.view !== 'graph';

  // ---- map geometry ----------------------------------------------------------------------------------
  function frame() { const c = G.project(M.lat, M.lng, M.z); return { ox: c.x - M.w / 2, oy: c.y - M.h / 2 }; }
  function toScreen(lat, lng) { const p = G.project(lat, lng, M.z), f = frame(); return { x: p.x - f.ox, y: p.y - f.oy }; }
  function fromScreen(x, y) { const f = frame(); return G.unproject(x + f.ox, y + f.oy, M.z); }
  function setCenter(lat, lng) { M.lat = Math.max(-84, Math.min(84, lat)); M.lng = ((lng + 540) % 360) - 180; }
  function zoomAt(px, py, z) {
    z = Math.max(minZoom(), Math.min(MAX_Z, z));
    const before = fromScreen(px, py);
    M.z = z;
    const p = G.project(before.lat, before.lng, z), c = G.unproject(p.x - (px - M.w / 2), p.y - (py - M.h / 2), z);
    setCenter(c.lat, c.lng); schedule();
  }
  function panBy(dx, dy) { const c = G.project(M.lat, M.lng, M.z), n = G.unproject(c.x - dx, c.y - dy, M.z); setCenter(n.lat, n.lng); schedule(); }
  function flyTo(lat, lng, z) {
    cancelAnimationFrame(M.fly);
    const tz = Math.max(minZoom(), Math.min(MAX_Z, z === undefined ? M.z : z));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !M.w) { M.z = tz; setCenter(lat, lng); schedule(); return; }
    const a = { lat: M.lat, lng: M.lng, z: M.z }, t0 = performance.now(), dur = 380;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
      M.z = a.z + (tz - a.z) * e; setCenter(a.lat + (lat - a.lat) * e, a.lng + (lng - a.lng) * e); draw();
      if (k < 1) M.fly = requestAnimationFrame(step); else schedule();
    };
    M.fly = requestAnimationFrame(step);
  }
  function fitBounds(b, pad = 80, maxZ = 17) {
    if (!b || !M.w) return;
    const z = Math.min(maxZ, G.fitZoom(b, M.w, M.h, pad)), c = G.unproject(...Object.values(midPx(b, z)), z);
    flyTo(c.lat, c.lng, z);
  }
  function midPx(b, z) { const a = G.project(b.n, b.w, z), c = G.project(b.s, b.e, z); return { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, z }; }
  function fitArea() {
    if (!M.area) { fitPins(); return; }
    if (!M.w) return;
    const minZ = M.tileInfo && M.tileInfo.available ? M.tileInfo.minzoom : 2;
    const z = Math.max(minZ, Math.min(16, G.fitZoom(M.area.bbox, M.w, M.h, 24)));
    const c = G.unproject(...Object.values(midPx(M.area.bbox, z)), z);
    flyTo(c.lat, c.lng, z);
  }
  function fitPins() {
    const list = pins();
    if (!list.length) { if (M.area) fitArea(); return; }
    if (list.length === 1) { flyTo(list[0].geo.lat, list[0].geo.lng, Math.max(M.z, 15)); return; }
    fitBounds(G.boundsOf(list.map(p => p.geo)), 90, 17);
  }

  // ---- drawing ---------------------------------------------------------------------------------------
  function schedule() { if (!M.raf) M.raf = requestAnimationFrame(() => { M.raf = 0; draw(); }); }
  function resize() {
    const r = el.frame.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (Math.abs(r.width - M.w) >= 1 || Math.abs(r.height - M.h) >= 1 || dpr !== M.dpr) {
      M.w = Math.round(r.width); M.h = Math.round(r.height); M.dpr = dpr;
      el.canvas.width = Math.round(M.w * dpr); el.canvas.height = Math.round(M.h * dpr);
      el.canvas.style.width = M.w + 'px'; el.canvas.style.height = M.h + 'px';
    }
    if (!M.positioned) initialPosition();
    schedule();
  }
  function initialPosition() {
    if (M.area) {
      const c = M.area.center, minZ = M.tileInfo && M.tileInfo.available ? M.tileInfo.minzoom : 2;
      M.lat = c.lat; M.lng = c.lng; M.z = Math.max(minZ, Math.min(16, G.fitZoom(M.area.bbox, M.w, M.h, 24)));
      M.positioned = true;
    } else {
      const list = pins();
      if (list.length) {
        const b = G.boundsOf(list.map(p => p.geo)), c = { lat: (b.s + b.n) / 2, lng: (b.w + b.e) / 2 };
        M.lat = c.lat; M.lng = c.lng; M.z = list.length > 1 ? Math.min(15, G.fitZoom(b, M.w, M.h, 120)) : 15;
        M.positioned = true;
      }
    }
  }
  function featureBounds(f) {
    if (f.b) return f.b;
    let a = 1, b = 1, c = 0, d = 0; const p = f.pts;
    for (let i = 0; i < p.length; i += 2) { if (p[i] < a) a = p[i]; if (p[i] > c) c = p[i]; if (p[i + 1] < b) b = p[i + 1]; if (p[i + 1] > d) d = p[i + 1]; }
    return (f.b = [a, b, c, d]);
  }
  function trace(ctx, f, s, f0, close) {
    const p = f.pts; let lx = 1e9, ly = 1e9, first = true;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i] * s - f0.ox, y = p[i + 1] * s - f0.oy;
      if (first) { ctx.moveTo(x, y); lx = x; ly = y; first = false; continue; }
      if (Math.abs(x - lx) + Math.abs(y - ly) < 0.7 && i < p.length - 2) continue;
      ctx.lineTo(x, y); lx = x; ly = y;
    }
    if (close) ctx.closePath();
  }
  function draw() {
    if (!M.w || !mapVisible()) return;
    const ctx = el.ctx, dpr = M.dpr, z = M.z, f0 = frame(), s = G.worldSize(z);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0f15'; ctx.fillRect(0, 0, M.w, M.h);
    const vis = ([a, b, c, d]) => c * s - f0.ox >= -20 && a * s - f0.ox <= M.w + 20 && d * s - f0.oy >= -20 && b * s - f0.oy <= M.h + 20;
    let areaRect = null;
    if (M.area) {
      const nw = G.normXY(M.area.bbox.n, M.area.bbox.w), se = G.normXY(M.area.bbox.s, M.area.bbox.e);
      areaRect = { x: nw.x * s - f0.ox, y: nw.y * s - f0.oy, w: (se.x - nw.x) * s, h: (se.y - nw.y) * s };
      ctx.fillStyle = '#101923'; ctx.fillRect(areaRect.x, areaRect.y, areaRect.w, areaRect.h);
    }
    const rasterOpaque = raster ? raster.drawRaster(ctx) : false;
    if (!rasterOpaque && !M.area) drawGrid(ctx, f0);
    const base = M.base;
    if (base && (M.basemap === 'vector' || M.basemap === 'hybrid' || !rasterOpaque)) {
      const overLight = rasterOpaque && (M.basemap === 'hybrid' || M.basemap === 'raster');
      ctx.save();
      if (overLight) ctx.globalAlpha = (M.hybridOpacity || 75) / 100;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const wf = 2 ** ((z - 14) * 0.55);
      if (M.layers.green) { ctx.fillStyle = overLight ? 'rgba(34,120,68,.24)' : 'rgba(70,130,92,.26)'; ctx.beginPath(); for (const f of base.green) if (vis(featureBounds(f))) trace(ctx, f, s, f0, true); ctx.fill(); }
      if (M.layers.water) {
        ctx.fillStyle = overLight ? 'rgba(20,90,145,.32)' : '#12314a'; ctx.beginPath(); for (const f of base.water) if (vis(featureBounds(f))) trace(ctx, f, s, f0, true); ctx.fill();
        ctx.strokeStyle = overLight ? '#165a96' : '#1b4f78'; ctx.lineWidth = Math.max(1, 2.2 * wf); ctx.beginPath(); for (const f of base.waterLines) if (vis(featureBounds(f))) trace(ctx, f, s, f0, false); ctx.stroke();
      }
      if (M.layers.roads) {
        if (z >= 11.5) { ctx.strokeStyle = overLight ? '#2c3a4f' : '#3b4656'; ctx.lineWidth = 1; ctx.setLineDash([6, 5]); ctx.beginPath(); for (const f of base.rail) if (vis(featureBounds(f))) trace(ctx, f, s, f0, false); ctx.stroke(); ctx.setLineDash([]); }
        const roadPass = (k, color, w, minZ) => {
          if (z < minZ) return;
          ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, Math.min(16, w * wf)); ctx.beginPath();
          for (const f of base.roads) if (f.k === k && vis(featureBounds(f))) trace(ctx, f, s, f0, false);
          ctx.stroke();
        };
        roadPass('minor', overLight ? '#365273' : '#2b3645', 1.8, 12.8);
        roadPass('secondary', overLight ? '#1f4e8c' : '#3d4d63', 2.8, 10);
        roadPass('major', overLight ? '#0f3970' : '#5d7898', 4.2, 0);
        if (z >= 14.5) drawRoadNames(ctx, base, s, f0, vis);
      }
      ctx.restore();
    }
    // Labels are always drawn on top at full opacity so they stay readable over the hybrid raster (1B.2).
    if (base && M.layers.labels) {
      drawLabels(ctx, base, s, f0, rasterOpaque && (M.basemap === 'hybrid' || M.basemap === 'raster'));
    }
    if (areaRect && raster) raster.drawAreaFrame(ctx, areaRect);
    drawZones(ctx);
    drawRoutes(ctx);
    drawMeasure(ctx);
    renderPins();
    updateScale(); updateHud(areaRect); updateTimeline();
  }
  function drawGrid(ctx, f0) {
    ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
    const step = 64, ox = -(f0.ox % step), oy = -(f0.oy % step);
    ctx.beginPath();
    for (let x = ox; x < M.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, M.h); }
    for (let y = oy; y < M.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(M.w, y); }
    ctx.stroke();
  }
  function drawRoadNames(ctx, base, s, f0, vis) {
    ctx.save(); ctx.font = '11px var(--font, sans-serif)'; ctx.fillStyle = '#9fb0c6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,15,21,.9)'; const used = [];
    for (const f of base.roads) {
      if (!f.n || f.k === 'minor' || !vis(featureBounds(f))) continue;
      const p = f.pts, i = (Math.floor(p.length / 4)) * 2;
      const x = p[i] * s - f0.ox, y = p[i + 1] * s - f0.oy;
      if (x < 30 || y < 12 || x > M.w - 30 || y > M.h - 12) continue;
      const w = ctx.measureText(f.n).width + 6;
      if (used.some(r => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - y) < 14)) continue;
      used.push({ x, y, w }); ctx.strokeText(f.n, x, y); ctx.fillText(f.n, x, y);
    }
    ctx.restore();
  }
  // ---- labels (1B.2) ---------------------------------------------------------------------------------
  // One visual style per label class. `spacing` uses the canvas `letterSpacing` property when the browser
  // supports it, so Arabic letters keep their joined shaping while administrative names still look airy.
  const LABEL_STYLE = {
    admin: { dark: '#b9c9da', light: '#25313f', weight: 600, size: 15.5, spacing: 2.5, caps: true },
    city: { dark: '#f2f7fd', light: '#101c26', weight: 800, size: 15, spacing: 0.3 },
    hood: { dark: '#cbd7e5', light: '#1d2a36', weight: 500, size: 12.5, spacing: 0 },
    landmark: { dark: '#d5deea', light: '#1b2734', weight: 500, size: 11, spacing: 0, dot: true },
    green: { dark: '#9fe0ac', light: '#146b3a', weight: 600, size: 11.5, spacing: 0.4 },
    water: { dark: '#8ccbf2', light: '#0f5c8c', weight: 500, size: 12, spacing: 0.6, italic: true },
  };

  function labelFont(item, fontSize) {
    const st = LABEL_STYLE[item.k] || LABEL_STYLE.hood;
    return `${st.italic ? 'italic ' : ''}${st.weight} ${fontSize || st.size}px var(--font, "Cairo", sans-serif)`;
  }

  // Which label classes are visible right now: the user's toggles, minus the classes the raster already
  // renders when we draw labels on top of it in hybrid mode.
  function enabledLabelClasses(onRaster) {
    const out = {};
    for (const k of LABEL_CLASS_KEYS) out[k] = M.labelClasses[k] !== false;
    if (onRaster && M.hybridHideRasterClasses) {
      // The offline raster pack burns place names into its tiles, so hide the classes it already shows to
      // avoid doubled text. Neighbourhood names are on the tiles at every zoom; city names only become
      // legible on the tiles from about z12.5, below that our own labels are the only ones worth showing.
      out.hood = false;
      if (M.z >= 12.5) out.city = false;
    }
    return out;
  }

  // Collects on-screen label candidates (screen px), lays them out with the pure, unit-tested collision
  // function from geo.js, then draws each class with its own style and halo.
  function drawLabels(ctx, base, s, f0, overLight) {
    const list = base.labels || [...(base.places || []), ...(base.areas || [])];
    if (!list || !list.length) return { drawn: 0, dropped: 0 };
    const candidates = [];
    for (const item of list) {
      const x = item.x * s - f0.ox, y = item.y * s - f0.oy;
      if (x < -60 || y < -24 || x > M.w + 60 || y > M.h + 24) continue;
      candidates.push({ ...item, x, y });
    }
    if (!candidates.length) return { drawn: 0, dropped: 0 };

    const placed = G.layoutLabels(candidates, {
      z: M.z,
      width: M.w,
      height: M.h,
      maxLabels: G.maxLabelsForView(M.w, M.h, 250),
      keepInside: true,
      lang: M.labelLang,
      enabledClasses: enabledLabelClasses(overLight),
      padding: 4,
      fadeSpan: 0.5,
      measureWidth: (line, fontSize, item) => {
        ctx.font = labelFont(item, fontSize);
        return ctx.measureText(line).width;
      },
    });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const canSpace = 'letterSpacing' in ctx;
    for (const it of placed) {
      const st = LABEL_STYLE[it.k] || LABEL_STYLE.hood;
      const color = overLight ? st.light : st.dark;
      const halo = overLight ? 'rgba(255,255,255,.97)' : 'rgba(8,13,19,.92)';
      ctx.font = labelFont(it, it.fontSize);
      if (canSpace) ctx.letterSpacing = `${st.spacing || 0}px`;
      ctx.globalAlpha = it.alpha;
      let cy = it.y - ((it.lines.length - 1) * it.lineHeight) / 2;
      if (st.dot) cy += 5;
      for (const line of it.lines) {
        // A slightly wider halo over light tiles keeps 4.5:1+ contrast on the busy raster cartography.
        ctx.lineWidth = Math.max(3, it.fontSize * (overLight ? 0.42 : 0.3));
        ctx.strokeStyle = halo;
        ctx.strokeText(line, it.x, cy);
        ctx.fillStyle = color;
        ctx.fillText(line, it.x, cy);
        cy += it.lineHeight;
      }
      if (st.dot) {
        // small dot marking the exact feature point of landmarks
        ctx.globalAlpha = it.alpha;
        ctx.beginPath();
        ctx.arc(it.x, it.y - it.lineHeight * 0.35, 2.1, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = halo;
        ctx.stroke();
      }
      if (canSpace) ctx.letterSpacing = '0px';
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    M.visibleLabels = placed.length;
    M.visibleLabelItems = placed.map(p => ({ n: p.n, k: p.k, r: p.r, lines: p.lines, box: p.box }));
    return { drawn: placed.length, dropped: candidates.length - placed.length };
  }
  // ---- geographic zones -----------------------------------------------------------------------------
  const ZONE_COLORS = ['#d4ff3f', '#2ee59d', '#5fb8ff', '#c3a0ff', '#ff8fa3', '#ffc861', '#ff7a6b', '#aab7c5'];
  function zoneById(id) { return (hostState().data.zones || []).find(z => String(z.id) === String(id)); }
  function zonePolygon(z) {
    if (z.shape !== 'rectangle' || !z.points || z.points.length !== 2) return z.points || [];
    const [a, b] = z.points;
    return [a, { lat: a.lat, lng: b.lng }, b, { lat: b.lat, lng: a.lng }];
  }
  const zoneCenterCache = new WeakMap();
  function zoneCenter(z) {
    if (z.shape === 'circle') return z.center;
    if (z !== M.zoneEdit && zoneCenterCache.has(z)) return zoneCenterCache.get(z);
    const pts = zonePolygon(z), b = G.boundsOf(pts);
    if (!b) return null;
    const precision = Math.max(0.00001, Math.max(b.n - b.s, b.e - b.w) / 100);
    const center = z.shape === 'rectangle' ? { lat: (b.n + b.s) / 2, lng: (b.e + b.w) / 2 } : (G.polylabel(pts, precision) || { lat: (b.n + b.s) / 2, lng: (b.e + b.w) / 2 });
    if (z !== M.zoneEdit) zoneCenterCache.set(z, center);
    return center;
  }
  function zoneContains(z, pt) {
    return z.shape === 'circle' ? G.haversine(z.center, pt) <= z.radius : G.pointInPolygon(pt, zonePolygon(z));
  }
  function zoneMetrics(z) {
    if (z.shape === 'circle') return { area: Math.PI * z.radius ** 2, perimeter: 2 * Math.PI * z.radius };
    const p = zonePolygon(z);
    return { area: G.polygonArea(p), perimeter: p.length ? G.pathLength([...p, p[0]]) : 0 };
  }
  function zoneVertices(z) {
    if (z.shape === 'circle') {
      const center = toScreen(z.center.lat, z.center.lng), r = z.radius / G.metersPerPixel(z.center.lat, M.z);
      return [{ ...center, key: 'center' }, { x: center.x + r, y: center.y, key: 'radius' }];
    }
    return (z.points || []).map((p, i) => ({ ...toScreen(p.lat, p.lng), key: i }));
  }
  function traceZone(ctx, z) {
    ctx.beginPath();
    if (z.shape === 'circle') {
      const p = toScreen(z.center.lat, z.center.lng), r = z.radius / G.metersPerPixel(z.center.lat, M.z);
      if (r < 1e6) ctx.arc(p.x, p.y, Math.max(0, r), 0, 2 * Math.PI);
      else return false;
    } else {
      const pts = zonePolygon(z); if (pts.length < 3) return false;
      pts.forEach((pt, i) => { const p = toScreen(pt.lat, pt.lng); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath();
    }
    return true;
  }
  function drawZones(ctx) {
    const visible = M.layers.zones && M.filters.kinds.zones;
    if (!visible && !M.zoneDraw && !M.zoneEdit) return;
    const zones = hostState().data.zones || [];
    ctx.save(); ctx.lineJoin = 'round';
    for (const original of zones) {
      if (!visible && (!M.zoneEdit || String(M.zoneEdit.id) !== String(original.id))) continue;
      const z = M.zoneEdit && String(M.zoneEdit.id) === String(original.id) ? M.zoneEdit : original;
      if (!traceZone(ctx, z)) continue;
      ctx.globalAlpha = .18; ctx.fillStyle = z.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(5,10,16,.9)'; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = z.color; ctx.lineWidth = 2.5; ctx.stroke();
      const center = zoneCenter(z); if (center) {
        const p = toScreen(center.lat, center.lng);
        ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 4;
        ctx.strokeStyle = '#0b0e12'; ctx.strokeText(z.name, p.x, p.y); ctx.fillStyle = '#fff'; ctx.fillText(z.name, p.x, p.y);
      }
      if (M.zoneEdit && String(M.zoneEdit.id) === String(z.id)) {
        for (const [i, p] of zoneVertices(z).entries()) { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI); ctx.fillStyle = i === M.zoneVertex ? '#d4ff3f' : '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#0b0e12'; ctx.stroke(); }
      }
    }
    const draft = M.zoneDraw;
    if (draft && draft.points.length) {
      const points = [...draft.points, ...(M.cursor ? [M.cursor] : [])];
      ctx.beginPath(); points.forEach((pt, i) => { const p = toScreen(pt.lat, pt.lng); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.setLineDash([6, 4]); ctx.lineWidth = 3; ctx.strokeStyle = '#d4ff3f'; ctx.stroke(); ctx.setLineDash([]);
      for (const p of points) { const q = toScreen(p.lat, p.lng); ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, 2 * Math.PI); ctx.fillStyle = '#d4ff3f'; ctx.fill(); }
    }
    ctx.restore();
  }
  function cancelZoneWork() { M.zoneDraw = null; M.zoneEdit = null; M.zoneEditBase = null; el.frame.classList.remove('zone-editing', 'zone-drawing'); banner(''); schedule(); }
  function startZoneDraw(shape, redrawId) {
    if (!['polygon', 'circle', 'rectangle'].includes(shape)) return;
    if (M.pick || M.measure || M.zoneDraw || M.zoneEdit) { closeMapPopovers(); toolBusyNotice(); return; }
    if (M.view === 'graph') setView('map');
    M.activeZone = null;
    M.zoneDraw = { shape, points: [], redrawId: redrawId || null, redrawBase: redrawId ? JSON.stringify(zoneById(redrawId) || null) : null }; el.frame.classList.add('zone-editing', 'zone-drawing');
    el.zoneMenu.hidden = true; $('[data-g=zone]', el.frame).setAttribute('aria-expanded', 'false');
    const instructions = shape === 'polygon' ? 'انقر لإضافة النقاط، ثم انقر مرتين للإنهاء.' : shape === 'circle' ? 'انقر لتحديد المركز ثم انقر لتحديد نصف القطر.' : 'انقر زاويتين متقابلتين للمستطيل.';
    banner(instructions + ' بلوحة المفاتيح: حرّك المركز بالأسهم واضغط مسافة لإضافة نقطة، ثم Enter لإنهاء المضلع.', [['إلغاء', cancelZoneWork]]); schedule();
    requestAnimationFrame(() => el.canvas.focus({ preventScroll: true }));
  }
  function finishZoneDraw() {
    const d = M.zoneDraw; if (!d) return;
    if (d.shape === 'polygon' && d.points.length < 3) { H().setStatus('يحتاج المضلع إلى ثلاث نقاط على الأقل.', false); return; }
    if (d.shape !== 'polygon' && d.points.length < 2) return;
    const original = d.redrawId && zoneById(d.redrawId);
    if (d.redrawId && (!original || JSON.stringify(original) !== d.redrawBase)) { zoneConflictNotice(); return; }
    const geometry = d.shape === 'circle' ? { center: d.points[0], radius: G.haversine(d.points[0], d.points[1]) } : { points: d.points.slice() };
    if (d.shape === 'circle' && geometry.radius < 1) { H().setStatus('نصف القطر صغير جدًا.', false); return; }
    const zone = { ...(original || {}), shape: d.shape, ...geometry };
    if (d.shape === 'circle') delete zone.points; else { delete zone.center; delete zone.radius; }
    M.zoneDraw = null; el.frame.classList.remove('zone-editing', 'zone-drawing'); banner(''); openZoneEditor(zone); schedule();
  }
  function zoneDrawClick(pt) {
    const d = M.zoneDraw; if (!d) return;
    d.points.push({ lat: round6(pt.lat), lng: round6(pt.lng) });
    if (d.shape !== 'polygon' && d.points.length === 2) finishZoneDraw();
    schedule();
  }
  function closeMapPopovers() {
    if (!el.frame) return;
    for (const [panel, control] of [[el.zoneMenu, '[data-g=zone]'], [el.filters, '[data-g=filters]'], [el.layers, '[data-g=layers]']]) {
      if (panel) panel.hidden = true;
      const button = $(control, el.frame); if (button) button.setAttribute('aria-expanded', 'false');
    }
    M.zoneRedrawId = null;
    el.frame.classList.remove('geo-tool-compact');
  }
  function toggleMapPopover(which, forceOpen = false) {
    const panel = which === 'zone' ? el.zoneMenu : which === 'filters' ? el.filters : el.layers;
    const open = forceOpen || panel.hidden;
    const redrawId = which === 'zone' && open ? M.zoneRedrawId : null;
    closeMapPopovers();
    if (open) {
      M.zoneRedrawId = redrawId; panel.hidden = false;
      const button = $(`[data-g=${which}]`, el.frame); if (button) button.setAttribute('aria-expanded', 'true');
      if (which === 'filters') renderFilters();
      positionToolBanner();
    }
  }
  function bindZoneMenu() {
    el.zoneMenu.addEventListener('click', e => { const b = e.target.closest('[data-zone-shape]'); if (b) { startZoneDraw(b.dataset.zoneShape, M.zoneRedrawId); M.zoneRedrawId = null; } else if (e.target.closest('[data-zone-io]')) { M.zoneRedrawId = null; el.zoneMenu.hidden = true; $('[data-g=zone]', el.frame).setAttribute('aria-expanded', 'false'); openGeoIO(); } });
  }
  function openGeoIO() {
    const m = ensureModal('geo-io'), form = $('form', m), h = H();
    $('h2', m).textContent = 'استيراد وتصدير المواقع';
    $('header p', m).textContent = 'GeoJSON وKML · دون اتصال · الحجم الأقصى 10 ميغابايت';
    form.innerHTML = `<p>تُضاف المواقع والمناطق المستوردة ولا تستبدل البيانات. تُستورد الأحداث الشخصية كأحداث مستقلة، ولا تُنقل العلاقات أو روابط المناطق.</p>
      <label class="geo-io-option"><input type="checkbox" id="gio-photos"><span>تضمين الصور في التصدير والاستيراد (قد يزيد حجم الملف)</span></label>
      <label class="geo-io-option"><input type="checkbox" id="gio-sensitive"><span>تضمين البيانات الحساسة (الهوية، الهاتف، البريد، الصحة)</span></label>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-io-export="geojson">تصدير GeoJSON</button><button type="button" class="secondary-btn" data-io-export="kml">تصدير KML</button></div>
      <label class="editor-field"><span>اختر ملفًا للمعاينة</span><input type="file" id="gio-file" accept=".geojson,.json,.kml,application/geo+json,application/json,application/vnd.google-earth.kml+xml"></label>
      <div id="gio-preview" aria-live="polite"></div><div class="ev-errors" id="gio-error" role="alert" hidden></div>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-m-close>إلغاء</button><button type="submit" class="primary-btn" id="gio-apply" disabled>إضافة المستورد</button></div>`;
    const file = $('#gio-file', form), include = $('#gio-photos', form), preview = $('#gio-preview', form), error = $('#gio-error', form), apply = $('#gio-apply', form);
    let source = '', format = '', result = null, generation = 0;
    function fail(message) { error.hidden = !message; error.textContent = message || ''; }
    function parse() {
      result = null; apply.disabled = true; preview.textContent = ''; fail('');
      if (!source) return;
      try {
        result = format === 'kml' ? IO.parseKML(source, { photos: include.checked }) : IO.parseGeoJSON(source, { photos: include.checked });
        const items = [...result.points.map(p => `موقع: ${p.name}`), ...result.zones.map(z => `منطقة: ${z.name}`)];
        preview.innerHTML = `<p>ستتم إضافة ${result.points.length} موقع و${result.zones.length} منطقة. لن يتغير شيء قبل الضغط على «إضافة المستورد».</p><ul>${items.slice(0, 30).map(x => `<li>${esc(x)}</li>`).join('')}</ul>${items.length > 30 ? `<p>و${items.length - 30} عنصرًا آخر.</p>` : ''}${result.warnings.length ? `<p role="status">تم تجاهل ${result.warnings.length} عنصر غير مدعوم أو غير صالح:</p><ul>${result.warnings.slice(0, 20).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
        apply.disabled = !items.length;
      } catch (ex) { fail(ex.message || 'تعذرت قراءة الملف.'); }
    }
    file.addEventListener('change', async () => {
      const seq = ++generation; source = ''; result = null; apply.disabled = true; preview.textContent = ''; fail('');
      const f = file.files && file.files[0]; if (!f) return;
      if (f.size > IO.LIMIT) { fail('الملف أكبر من 10 ميغابايت.'); return; }
      format = /\.kml$/i.test(f.name) ? 'kml' : 'geojson';
      try { const contents = await f.text(); if (seq !== generation) return; source = contents; parse(); } catch (_) { if (seq === generation) fail('تعذرت قراءة الملف.'); }
    });
    include.addEventListener('change', parse);
    form.addEventListener('click', e => {
      const b = e.target.closest('[data-io-export]'); if (!b) return;
      try {
        const isKml = b.dataset.ioExport === 'kml', value = isKml ? IO.toKML(h.state.data, { photos: include.checked, sensitive: $('#gio-sensitive', form).checked }) : JSON.stringify(IO.toGeoJSON(h.state.data, { photos: include.checked, sensitive: $('#gio-sensitive', form).checked }), null, 2);
        const blob = new Blob([value], { type: isKml ? 'application/vnd.google-earth.kml+xml' : 'application/geo+json' });
        if (blob.size > IO.LIMIT) throw new Error('الملف أكبر من 10 ميغابايت؛ جرّب التصدير دون الصور.');
        const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = isKml ? 'locations.kml' : 'locations.geojson'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); fail('');
      } catch (ex) { fail(ex.message || 'تعذر تصدير الملف.'); }
    });
    form.onsubmit = e => {
      e.preventDefault(); if (!result || apply.disabled) return;
      try {
        const nodes = [...h.state.data.nodes], zones = [...(h.state.data.zones || [])];
        let id = h.nextId(nodes); const ids = new Set(nodes.map(n => String(n.id)));
        for (const p of result.points) {
          while (ids.has(String(id))) id++;
          const n = { id, label: p.name, schema: p.kind === 'event' ? 'Event' : 'Thing', geo: p.geo };
          if (p.profile) n.profile = p.profile;
          if (p.kind === 'event') { n.eventType = p.eventType || 'other'; n.summary = p.description; if (p.date) n.date = p.date; if (p.datePrecision) n.datePrecision = p.datePrecision; }
          else if (p.description) n.summary = p.description;
          nodes.push(n); ids.add(String(id++));
        }
        const zids = new Set(zones.map(z => String(z.id))); let zi = 0;
        for (const z of result.zones) { let zid; do { zid = `import-${Date.now().toString(36)}-${zi++}`; } while (zids.has(zid)); zids.add(zid); zones.push({ ...z, id: zid }); }
        const dataset = { nodes, edges: h.state.data.edges, zones };
        if (nodes.length > 100000 || JSON.stringify(dataset).length > 12 * 1024 * 1024) throw new Error('البيانات بعد الاستيراد أكبر من الحد المسموح.');
        window.RelationshipDataValidation.validateDataset(dataset);
        h.state.data.nodes = nodes; h.state.data.zones = zones;
        m.classList.remove('open'); h.refreshAfterMutation('تم استيراد المواقع والمناطق', h.state.selected, { keepView: true }); sync(true);
      } catch (ex) { fail(ex.message || 'تعذر تطبيق الاستيراد.'); }
    };
    m.classList.add('open'); setTimeout(() => file.focus(), 30);
  }
  function openZoneEditor(zone) {
    const existing = zone.id && zoneById(zone.id), m = ensureModal('geo-zone-edit'), form = $('form', m), h = H();
    $('h2', m).textContent = existing ? 'تعديل المنطقة' : 'منطقة جديدة';
    $('header p', m).textContent = 'اسم المنطقة وشكلها وصورها تُحفظ مع البيانات وتعمل دون اتصال';
    const links = [];
    for (const n of h.state.nodes) {
      links.push({ key: `n:${n.id}`, label: h.labelOf(n) });
      for (const ev of n.events || []) if (ev && ev.id !== undefined) links.push({ key: `e:${n.id}:${ev.id}`, label: `${ev.title || 'حدث'} · ${h.labelOf(n)}` });
    }
    const color = ZONE_COLORS.includes(zone.color) ? zone.color : ZONE_COLORS[0];
    form.innerHTML = `<div class="ev-grid"><label class="editor-field wide"><span>اسم المنطقة *</span><input id="gz-name" maxlength="200" value="${esc(zone.name || '')}"></label>
      <label class="editor-field wide"><span>الربط بكيان أو حدث (اختياري)</span><select id="gz-link"><option value="">بلا ارتباط</option>${links.map(x => opt(x.key, x.label, zone.link && zone.link.key === x.key)).join('')}</select></label>
      <label class="editor-field wide"><span>ملاحظة</span><textarea id="gz-note" rows="3" maxlength="10000">${esc(zone.note || '')}</textarea></label></div>
      <fieldset class="gz-colors"><legend>لون المنطقة</legend>${ZONE_COLORS.map(c => `<label title="${c}"><input type="radio" name="gz-color" value="${c}" ${c === color ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</fieldset>
      <div id="gz-photos"></div><div class="ev-errors" id="gz-errors" role="alert" hidden></div>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-m-close>إلغاء</button><button type="submit" class="primary-btn">حفظ المنطقة</button></div>`;
    const g = id => $(id, form), err = msgs => { const box = g('#gz-errors'); box.hidden = !msgs.length; box.innerHTML = msgs.map(x => `<p>${esc(x)}</p>`).join(''); };
    const center = zone.shape === 'circle' ? zone.center : zone.points[0];
    const component = mountLocationFields(g('#gz-photos'), { ...center, place: '', address: '', note: '', photos: zone.photos || [] }, { onError: err });
    g('#gz-photos .ev-grid').hidden = true;
    form.onsubmit = e => {
      e.preventDefault();
      const name = g('#gz-name').value.trim(); if (!name) { err(['اكتب اسم المنطقة.']); return; }
      const photoGeo = component.read(), photos = photoGeo ? photoGeo.photos : [];
      const result = { ...zone, id: zone.id || `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, color: $('input[name=gz-color]:checked', form).value, note: g('#gz-note').value.trim(), photos };
      if (g('#gz-link').value) result.link = { key: g('#gz-link').value }; else delete result.link;
      const zones = [...(h.state.data.zones || [])], at = zones.findIndex(z => String(z.id) === String(result.id));
      if (at < 0) zones.push(result); else zones[at] = result;
      if (JSON.stringify({ ...h.state.data, zones }).length > 12 * 1024 * 1024) { err(['حجم البيانات مع الصور كبير جدًا.']); return; }
      try { window.RelationshipDataValidation.validateDataset({ nodes: h.state.data.nodes, edges: h.state.data.edges, zones }); }
      catch (ex) { err([ex.message]); return; }
      h.state.data.zones = zones; m.classList.remove('open'); M.activeZone = String(result.id); M.hideCard = null; M.photoIdx = 0;
      h.refreshAfterMutation(existing ? 'تم تعديل المنطقة' : 'تمت إضافة المنطقة', h.state.selected, { keepView: true }); sync(true);
      if (!M.layers.zones || !M.filters.kinds.zones) h.setStatus('حُفظت المنطقة، لكنها مخفية بسبب إعدادات الطبقات أو التصفية.');
    };
    m.classList.add('open'); setTimeout(() => g('#gz-name')?.focus(), 30);
  }
  function resolveZoneLink(key) {
    for (const node of hostState().nodes) {
      if (`n:${node.id}` === key) return { key, node, kind: node.schema === 'Event' ? 'shared-event' : 'entity', geo: G.geoOf(node) };
      for (const event of node.events || []) if (event && `e:${node.id}:${event.id}` === key) return { key, node, event, kind: 'personal-event', geo: G.normalizeGeo(event.geo) };
    }
    return null;
  }
  function renderZoneCard(z) {
    const metrics = zoneMetrics(z), photos = z.photos || [], index = Math.min(M.photoIdx, Math.max(0, photos.length - 1)), current = photos[index];
    const media = current ? `<div class="geo-media"><img data-zone-photo alt="${esc(current.caption || z.name)}" src="${esc(current.src)}" referrerpolicy="no-referrer">${photos.length > 1 ? `<button type="button" class="geo-nav prev" data-zone-prev aria-label="السابقة">${ICON.chev}</button><button type="button" class="geo-nav next" data-zone-next aria-label="التالية">${ICON.chev}</button>` : ''}<span class="geo-count">${index + 1} / ${photos.length}</span></div>${current.caption ? `<p class="geo-caption">${esc(current.caption)}</p>` : ''}` : '';
    const inside = G.collectMapPins(hostState().nodes).filter(p => zoneContains(z, p.geo)).slice(0, 100);
    const linked = z.link && resolveZoneLink(z.link.key);
    const chip = p => `<button type="button" class="entity-chip" data-zone-goto="${esc(p.key)}"><span>${esc(pinTitle(p))}</span></button>`;
    return `<button type="button" class="icon-btn geo-close" data-zone-close aria-label="إغلاق">×</button>${media}<div class="geo-body"><span class="geo-type" style="--c:${esc(z.color)}"><i></i>منطقة</span><h3>${esc(z.name)}</h3><p class="geo-note">المساحة: ${esc(G.formatArea(metrics.area))} · المحيط: ${esc(G.formatDistance(metrics.perimeter))}</p>${z.note ? `<p class="geo-note">${esc(z.note)}</p>` : ''}${linked ? `<section><strong>مرتبط بـ</strong><div class="geo-rels">${chip(linked)}</div></section>` : ''}<section><strong>داخل هذه المنطقة (${inside.length})</strong><div class="geo-rels">${inside.map(chip).join('') || '<span class="geo-note">لا توجد مواقع داخل المنطقة.</span>'}</div></section><div class="geo-actions"><button type="button" class="secondary-btn" data-zone-edit>تعديل</button><button type="button" class="secondary-btn" data-zone-shape-edit>تغيير الشكل</button><button type="button" class="secondary-btn" data-zone-redraw>إعادة الرسم</button><button type="button" class="danger-btn secondary-btn" data-zone-delete>حذف</button></div></div>`;
  }
  async function handleZoneCardClick(t, zone) {
    const d = t.dataset, photos = zone.photos || [];
    if (d.zoneClose !== undefined) { M.activeZone = null; el.card.hidden = true; }
    else if (d.zonePrev !== undefined) { M.photoIdx = (M.photoIdx - 1 + photos.length) % photos.length; renderCard(); }
    else if (d.zoneNext !== undefined) { M.photoIdx = (M.photoIdx + 1) % photos.length; renderCard(); }
    else if (d.zonePhoto !== undefined) lightbox(photos, M.photoIdx);
    else if (d.zoneGoto) { const p = resolveZoneLink(d.zoneGoto); if (p) { M.activeZone = null; if (p.geo) focusSearchPin(p); else showInGraph(p.node.id); } }
    else if (d.zoneEdit !== undefined) openZoneEditor(zone);
    else if (d.zoneShapeEdit !== undefined) beginZoneEdit(zone);
    else if (d.zoneRedraw !== undefined) { M.zoneRedrawId = zone.id; toggleMapPopover('zone', true); }
    else if (d.zoneDelete !== undefined) {
      const ok = await H().confirmDialog({ title: 'حذف المنطقة؟', subject: { name: zone.name, sub: 'منطقة مرسومة', color: zone.color }, message: 'ستُحذف المنطقة فقط؛ تبقى الكيانات والأحداث.', hint: 'يمكنك التراجع بعد الحذف.', confirmText: 'حذف المنطقة' });
      if (ok) { H().state.data.zones = (H().state.data.zones || []).filter(x => String(x.id) !== String(zone.id)); M.activeZone = null; H().refreshAfterMutation('حُذفت المنطقة', H().state.selected, { keepView: true }); sync(true); }
    }
  }
  function zoneEditBanner() {
    const count = zoneVertices(M.zoneEdit).length;
    banner(`النقطة ${M.zoneVertex + 1} من ${count}. اسحب النقاط؛ انقر الحافة للإضافة وبالزر الأيمن للحذف. لوحة المفاتيح: الأسهم للتحريك، Page Up وPage Down للتنقل، Insert للإضافة وDelete للحذف، Shift مع الأسهم لتحريك الخريطة.`, [['حفظ الشكل', saveZoneEdit], ['إلغاء', cancelZoneWork]]);
  }
  function beginZoneEdit(zone) {
    if (M.pick || M.measure || M.zoneDraw || M.zoneEdit) { toolBusyNotice(); return; }
    closeMapPopovers(); M.zoneEdit = JSON.parse(JSON.stringify(zone)); M.zoneEditBase = JSON.stringify(zone); M.zoneDraw = null; M.zoneVertex = 0; el.frame.classList.add('zone-editing');
    zoneEditBanner(); schedule(); requestAnimationFrame(() => el.canvas.focus({ preventScroll: true }));
  }
  function editZoneWithKeyboard(e) {
    const z = M.zoneEdit, vertices = zoneVertices(z); if (!z || !vertices.length) return false;
    M.zoneVertex = Math.max(0, Math.min(M.zoneVertex, vertices.length - 1));
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      M.zoneVertex = (M.zoneVertex + (e.key === 'PageDown' ? 1 : vertices.length - 1)) % vertices.length;
    } else if (e.key === 'Insert' && z.shape === 'polygon' && z.points.length < 10000) {
      const a = vertices[M.zoneVertex], b = vertices[(M.zoneVertex + 1) % vertices.length], p = fromScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
      z.points.splice(M.zoneVertex + 1, 0, { lat: round6(p.lat), lng: round6(p.lng) }); M.zoneVertex++;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && z.shape === 'polygon') {
      if (z.points.length > 3) { z.points.splice(M.zoneVertex, 1); M.zoneVertex = Math.min(M.zoneVertex, z.points.length - 1); }
      else H().setStatus('يحتاج المضلع إلى ثلاث نقاط على الأقل.', false);
    } else if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const v = vertices[M.zoneVertex], dx = e.key === 'ArrowLeft' ? -8 : e.key === 'ArrowRight' ? 8 : 0, dy = e.key === 'ArrowUp' ? -8 : e.key === 'ArrowDown' ? 8 : 0;
      const p = fromScreen(v.x + dx, v.y + dy), pt = { lat: round6(p.lat), lng: round6(p.lng) };
      if (v.key === 'center') z.center = pt;
      else if (v.key === 'radius') z.radius = Math.max(1, G.haversine(z.center, pt));
      else z.points[v.key] = pt;
    } else return false;
    e.preventDefault(); e.stopPropagation(); zoneEditBanner(); schedule(); return true;
  }
  function zoneConflictNotice() {
    H().setStatus('تغيّرت المنطقة أثناء التحرير. ألغِ المسودة وأعد فتح المنطقة لتجنب الكتابة فوق التغييرات.', false);
    let note = $('.geo-tool-warning', el.banner); if (!note) { note = document.createElement('span'); note.className = 'geo-tool-warning'; note.setAttribute('role', 'status'); el.banner.append(note); }
    note.textContent = 'تغيّرت المنطقة. ألغِ المسودة وأعد فتحها.';
  }
  function saveZoneEdit() {
    const draft = M.zoneEdit, zones = hostState().data.zones || []; if (!draft) return;
    const at = zones.findIndex(z => String(z.id) === String(draft.id));
    if (at < 0 || JSON.stringify(zones[at]) !== M.zoneEditBase) { zoneConflictNotice(); return; }
    const next = zones.slice(); next[at] = draft;
    try { window.RelationshipDataValidation.validateDataset({ nodes: hostState().data.nodes, edges: hostState().data.edges, zones: next }); }
    catch (e) { H().setStatus(e.message, false); return; }
    hostState().data.zones = next; M.zoneEdit = null; M.zoneEditBase = null; el.frame.classList.remove('zone-editing'); banner(''); M.activeZone = String(draft.id);
    H().refreshAfterMutation('تم تغيير شكل المنطقة', hostState().selected, { keepView: true }); sync(true);
  }

  // Event routes and the selected entity's dated journey share the same projection and hit testing.
  function journeyStops() {
    if (!M.layers.journey || !M.selected) return [];
    const id = String(M.selected), linked = new Set((hostState().adjacency.get(id) || []).map(r => String(r.other)));
    return pins().filter(p => p.kind !== 'entity' && (String(p.node.id) === id || (p.kind === 'shared-event' && linked.has(String(p.node.id)))))
      .map(p => ({ p, ev: p.kind === 'personal-event' ? C.normalizePersonal(p.event, p.node.id) : C.normalizeEvent(p.node) }))
      .filter(x => C.sortKey(x.ev)).sort((a, b) => C.sortKey(a.ev).localeCompare(C.sortKey(b.ev)) || a.p.key.localeCompare(b.p.key));
  }
  function screenRoute(a, b) {
    const size = G.worldSize(M.z);
    const pts = G.routePoints(a, b, 32).map(pt => toScreen(pt.lat, pt.lng));
    for (let i = 1; i < pts.length; i++) {
      while (pts[i].x - pts[i - 1].x > size / 2) pts[i].x -= size;
      while (pts[i].x - pts[i - 1].x < -size / 2) pts[i].x += size;
    }
    return pts;
  }
  function strokeRoute(ctx, pts, color, animated) {
    if (pts.length < 2) return;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]); ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(5,10,16,.88)'; ctx.stroke();
    ctx.setLineDash([9, 6]); ctx.lineDashOffset = animated ? -(performance.now() / 90) % 15 : 0; ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke(); ctx.setLineDash([]);
    const a = pts[pts.length - 2], b = pts[pts.length - 1], angle = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 13 * Math.cos(angle - .5), b.y - 13 * Math.sin(angle - .5)); ctx.lineTo(b.x - 13 * Math.cos(angle + .5), b.y - 13 * Math.sin(angle + .5)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0e12'; ctx.stroke();
  }
  function drawRoutes(ctx) {
    M.routeHits = [];
    const routes = M.filters.kinds.routes ? pins().filter(p => p.kind !== 'entity' && p.geo.to) : [], stops = M.filters.kinds.routes ? journeyStops() : [];
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ctx.save();
    for (const item of routes) {
      const pts = screenRoute(item.geo, item.geo.to); if (pts.length < 2) continue;
      const color = pinColor(item); strokeRoute(ctx, pts, color, !reduced);
      const end = pts[pts.length - 1], mid = pts[Math.floor(pts.length / 2)];
      ctx.beginPath(); ctx.arc(end.x, end.y, 6, 0, 2 * Math.PI); ctx.fillStyle = '#0b0e12'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
      const label = G.formatDistance(G.haversine(item.geo, item.geo.to));
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 4; ctx.strokeStyle = '#0b0e12'; ctx.strokeText(label, mid.x, mid.y - 5); ctx.fillStyle = '#fff'; ctx.fillText(label, mid.x, mid.y - 5);
      M.routeHits.push({ key: item.key, pts });
    }
    let distance = 0;
    if (stops.length > 1) {
      for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1].p.geo, b = stops[i].p.geo;
        distance += G.haversine(a, b); strokeRoute(ctx, screenRoute(a, b), '#d4ff3f', false);
      }
      stops.forEach((stop, i) => {
        const p = toScreen(stop.p.geo.lat, stop.p.geo.lng);
        ctx.beginPath(); ctx.arc(p.x + 17, p.y + 5, 11, 0, Math.PI * 2); ctx.fillStyle = '#0b0e12'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#d4ff3f'; ctx.stroke(); ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), p.x + 17, p.y + 5);
      });
    }
    ctx.restore();
    if (el.journeyTotal) el.journeyTotal.textContent = stops.length > 1 ? `مسار الكيان: ${G.formatDistance(distance)} · ${stops.length} محطات` : '';
    if (routes.length && !reduced && mapVisible()) schedule();
  }
  function segmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / n)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  function hitRoute(p) {
    for (const hit of M.routeHits || []) {
      if (hit.pts.some((q, i) => i && segmentDistance(p, hit.pts[i - 1], q) <= 9) || Math.hypot(p.x - hit.pts[hit.pts.length - 1].x, p.y - hit.pts[hit.pts.length - 1].y) <= 12) return pinByKey(hit.key);
    }
    return null;
  }
  function drawMeasure(ctx) {
    if (!M.measure || !M.measure.pts.length) return;
    const pts = M.measure.pts.map(p => toScreen(p.lat, p.lng));
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (M.measure.cursor && !M.measure.done) { const c = toScreen(M.measure.cursor.lat, M.measure.cursor.lng); ctx.lineTo(c.x, c.y); }
    if (pts.length > 2) { ctx.fillStyle = 'rgba(205,254,100,.16)'; ctx.fill(); }
    ctx.strokeStyle = 'rgba(10,15,21,.88)'; ctx.lineWidth = 5.5; ctx.setLineDash([]); ctx.stroke();
    ctx.strokeStyle = '#cdfe64'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = '#cdfe64'; ctx.strokeStyle = '#0a0f15'; ctx.lineWidth = 2;
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, 7); ctx.fill(); ctx.stroke(); });
    ctx.restore();
  }

  // ---- pins ------------------------------------------------------------------------------------------
  function renderPins() {
    const layer = el.pins, used = new Set();
    if (!M.layers.pins) { layer.replaceChildren(); M.pinEls.clear(); el.count.textContent = ''; return; }
    const list = pins(), f0 = frame();
    const total = allPins().length;
    el.count.textContent = total ? `${list.length} من ${total} موقعًا` : '';
    const items = [];
    for (const item of list) {
      const { geo } = item;
      const w = G.project(geo.lat, geo.lng, M.z), x = w.x - f0.ox, y = w.y - f0.oy;
      if (x < -60 || y < -80 || x > M.w + 60 || y > M.h + 60) continue;
      items.push({ ...item, id: item.key, x: w.x, y: w.y });
    }
    const sel = M.activeEvent || (M.selected && `n:${M.selected}`), singles = [], groups = [];
    const rest = items.filter(i => i.id !== sel);
    for (const c of G.cluster(rest, 46)) {
      if (c.count === 1) singles.push(rest.find(i => i.id === c.ids[0])); else groups.push(c);
    }
    const selItem = items.find(i => i.id === sel); if (selItem) singles.push(selItem);
    const put = (key, make, x, y, z, sig) => {
      let e = M.pinEls.get(key);
      if (e && sig && e.dataset.sig !== sig) { e.remove(); M.pinEls.delete(key); e = null; }
      if (!e) { e = make(); if (sig) e.dataset.sig = sig; M.pinEls.set(key, e); layer.append(e); }
      e.style.transform = `translate(${Math.round(x - f0.ox)}px,${Math.round(y - f0.oy)}px)`; e.style.zIndex = z; used.add(key);
      return e;
    };
    for (const it of singles) {
      const cover = pinCover(it), sig = [pinColor(it), pinTitle(it), it.geo.place, cover.length, cover.slice(-24)].join('|');
      const e = put('p' + it.id, () => makePin(it), it.x, it.y, it.id === sel ? 30 : 10 + Math.round(it.y / 100), sig);
      e.classList.toggle('selected', it.id === sel);
      e.classList.toggle('labeled', M.z >= 14.5 || it.id === sel);
      e.classList.toggle('geo-pulse', M.time.pulses.has(it.key));
    }
    for (const c of groups) {
      const key = 'c' + c.ids.slice().sort().join(',');
      const e = put(key, () => makeCluster(c), c.x, c.y, 20);
      e.querySelector('b').textContent = c.count;
    }
    for (const [k, e] of M.pinEls) if (!used.has(k)) { e.remove(); M.pinEls.delete(k); }
  }
  function makePin(item) {
    const { node, geo: g } = item, col = pinColor(item), cover = pinCover(item), title = pinTitle(item);
    const mark = item.kind === 'entity' ? initialOf(node) : '⚑';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'geo-pin' + (item.kind !== 'entity' ? ' geo-event-pin' : '');
    b.dataset.id = String(node.id); b.dataset.key = item.key; b.dataset.kind = item.kind; b.style.setProperty('--c', col);
    b.setAttribute('aria-label', `${title} — ${g.place || (item.kind === 'entity' ? typeLabelOf(node) : 'حدث')}`);
    b.innerHTML = `<span class="geo-pin-head">${cover ? `<img alt="" src="${esc(cover)}" referrerpolicy="no-referrer">` : `<i>${esc(mark)}</i>`}</span><span class="geo-pin-tip"></span><span class="geo-pin-label">${esc(title)}</span>`;
    const img = b.querySelector('img'); if (img) img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('i'), { textContent: mark })); });
    return b;
  }
  function makeCluster(c) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'geo-cluster'; b.dataset.ids = JSON.stringify(c.ids);
    b.setAttribute('aria-label', `${c.count} مواقع متقاربة؛ انقر للتقريب`); b.innerHTML = '<b></b>';
    return b;
  }
  function onPinsClick(e) {
    const cl = e.target.closest('.geo-cluster');
    if (cl) {
      const ids = JSON.parse(cl.dataset.ids), lookup = new Map(pins().map(p => [p.key, p.geo])), pts = ids.map(id => lookup.get(id)).filter(Boolean);
      if (!pts.length) return;
      const b = G.boundsOf(pts); if (b && (b.n - b.s > 1e-5 || b.e - b.w > 1e-5)) fitBounds(b, 120, 18); else flyTo(pts[0].lat, pts[0].lng, M.z + 2);
      return;
    }
    const pin = e.target.closest('.geo-pin'); if (!pin) return;
    const item = pinByKey(pin.dataset.key); if (!item) return;
    e.stopPropagation(); M.activeZone = null; M.hideCard = null; M.photoIdx = 0;
    H().selectNode(String(item.node.id));
    M.activeEvent = item.kind === 'entity' ? null : item.key;
    sync(true);
  }

  // ---- selection sync + info card --------------------------------------------------------------------
  let syncQueued = false;
  function sync(force) {
    if (!force) { if (syncQueued) return; syncQueued = true; requestAnimationFrame(() => { syncQueued = false; syncNow(); }); return; }
    syncNow();
  }
  function syncNow() {
    if (!el.frame) return;
    const sel = hostState().selected, id = sel ? String(sel) : null;
    if (id !== M.selected) {
      const active = M.activeEvent && pinByKey(M.activeEvent);
      if (!active || String(active.node.id) !== id) M.activeEvent = null;
      M.selected = id; M.photoIdx = 0; M.hideCard = null; if (id && mapVisible() && !M.activeEvent) ensureVisible(id);
    }
    if (mapVisible()) { schedule(); renderCard(); }
  }
  function ensureVisible(id) {
    const g = G.geoOf(nodeById(id)); if (!g || !M.w) return;
    const p = toScreen(g.lat, g.lng);
    if (p.x < 60 || p.y < 120 || p.x > M.w - 60 || p.y > M.h - 40) flyTo(g.lat, g.lng, Math.max(M.z, 14));
  }
  function galleryOf(node, g) {
    const arr = g.photos.map(p => ({ src: p.src, caption: p.caption }));
    if (!arr.length && node.photo) arr.push({ src: node.photo, caption: '' });
    return arr;
  }
  function locationBody(node, g, opts = {}) {
    const photos = galleryOf(node, g), idx = Math.min(M.photoIdx, Math.max(0, photos.length - 1)), cur = photos[idx];
    const rels = opts.related || (hostState().adjacency.get(String(node.id)) || []).map(r => nodeById(r.other)).filter(Boolean).slice(0, 4);
    const link = `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=17/${g.lat}/${g.lng}`;
    const media = photos.length
      ? `<div class="geo-media"><img data-geo-open-photo alt="${esc(cur.caption || g.place || H().labelOf(node))}" src="${esc(cur.src)}" referrerpolicy="no-referrer">${photos.length > 1 ? `<button type="button" class="geo-nav prev" data-geo-prev aria-label="السابقة">${ICON.chev}</button><button type="button" class="geo-nav next" data-geo-next aria-label="التالية">${ICON.chev}</button><span class="geo-dots">${photos.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</span>` : ''}<span class="geo-count">${ICON.image}${idx + 1} / ${photos.length}</span></div>${cur.caption ? `<p class="geo-caption">${esc(cur.caption)}</p>` : ''}`
      : `<div class="geo-media empty"><span>${ICON.image}<small>لا توجد صور لهذا الموقع</small></span></div>`;
    return `${media}<div class="geo-body"><span class="geo-type" style="--c:${colorOf(node)}"><i></i>${esc(typeLabelOf(node))}</span><h3>${esc(H().labelOf(node))}</h3>
      ${opts.event ? `<p class="geo-note">${esc(C.formatDate(opts.event))}</p>` : ''}
      ${g.place ? `<p class="geo-place">${ICON.pin}<span>${esc(g.place)}</span></p>` : ''}${g.address ? `<p class="geo-addr">${esc(g.address)}</p>` : ''}
      <p class="geo-coords"><span dir="ltr">${esc(G.formatCoord(g.lat, g.lng))}</span><button type="button" class="chip-btn" data-geo-copy>نسخ</button><a class="chip-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">OSM ↗</a></p>
      ${g.note ? `<p class="geo-note">${esc(g.note)}</p>` : ''}
      ${node.summary && !opts.compact ? `<p class="geo-note dim">${esc(node.summary)}</p>` : ''}
      ${rels.length ? `<div class="geo-rels">${rels.map(r => `<button type="button" class="entity-chip" data-geo-goto="${esc(r.id)}" style="--c:${colorOf(r)}"><i class="legend-dot" style="background:${colorOf(r)}"></i><span><b>${esc(H().labelOf(r))}</b></span></button>`).join('')}</div>` : ''}
      <div class="geo-actions"><button type="button" class="secondary-btn" data-geo-graph>عرض في الشبكة</button><button type="button" class="secondary-btn" data-geo-edit>${opts.event ? 'تعديل' : 'تعديل الموقع'}</button>${opts.remove ? '<button type="button" class="danger-btn secondary-btn" data-geo-del>إزالة الموقع</button>' : ''}</div></div>`;
  }
  function activeEventRecord() {
    const p = M.activeEvent && pinByKey(M.activeEvent);
    if (!p || p.kind === 'entity') return null;
    const ev = p.kind === 'personal-event' ? C.normalizePersonal(p.event, p.node.id) : C.normalizeEvent(p.node);
    const displayNode = p.kind === 'personal-event' ? { ...p.node, schema: 'Event', eventType: ev.type, label: ev.title, summary: ev.description, photo: '' } : p.node;
    const related = p.kind === 'personal-event' ? [p.node] : (hostState().adjacency.get(String(p.node.id)) || []).map(r => nodeById(r.other)).filter(n => n && n.schema !== 'Event');
    return { ...p, ev, displayNode, related };
  }
  function renderCard() {
    const card = el.card, zone = M.activeZone && zoneById(M.activeZone);
    if (zone) { if (!M.layers.zones || !M.filters.kinds.zones || !mapVisible()) { card.hidden = true; return; } card.hidden = false; card.innerHTML = renderZoneCard(zone); return; }
    const id = M.selected, active = activeEventRecord();
    const node = active ? active.displayNode : (id && nodeById(id)), g = active ? active.geo : (node && G.geoOf(node));
    const cardKey = active ? active.key : id;
    if (!g || M.hideCard === cardKey || !mapVisible()) { card.hidden = true; return; }
    card.hidden = false; card.dataset.id = id;
    card.innerHTML = `<button type="button" class="icon-btn geo-close" data-geo-close aria-label="إغلاق البطاقة">×</button>${locationBody(node, g, active ? { event: active.ev, related: active.related } : {})}`;
  }
  function bindLocationActions(root, id, scope) {
    root.addEventListener('click', e => {
      const t = e.target.closest('button,img[data-geo-open-photo]'); if (!t) return;
      const d = t.dataset, node = nodeById(id), g = node && G.geoOf(node); if (!g) return;
      const photos = galleryOf(node, g);
      if (d.geoClose !== undefined) { M.hideCard = String(id); el.card.hidden = true; }
      else if (d.geoPrev !== undefined) { M.photoIdx = (M.photoIdx - 1 + photos.length) % photos.length; scope(); }
      else if (d.geoNext !== undefined) { M.photoIdx = (M.photoIdx + 1) % photos.length; scope(); }
      else if (d.geoOpenPhoto !== undefined) lightbox(photos, M.photoIdx);
      else if (d.geoCopy !== undefined) { try { navigator.clipboard.writeText(G.formatCoord(g.lat, g.lng)); H().setStatus('تم نسخ الإحداثيات'); } catch (_) { /* clipboard unavailable */ } }
      else if (d.geoGoto) { M.hideCard = null; H().selectNode(d.geoGoto); const t2 = G.geoOf(nodeById(d.geoGoto)); if (t2 && mapVisible()) flyTo(t2.lat, t2.lng, Math.max(M.z, 15)); }
      else if (d.geoGraph !== undefined) showInGraph(id);
      else if (d.geoEdit !== undefined) openLocEditor({ nodeId: id });
      else if (d.geoDel !== undefined) removeLocation(id);
      else if (d.geoShow !== undefined) showOnMap(id);
    });
  }
  function showInGraph(id) {
    if (M.view === 'map') setView('graph');
    H().selectNode(String(id)); H().centerOn(String(id));
  }
  function showOnMap(id) {
    const g = G.geoOf(nodeById(id)); if (!g) return;
    if (M.view === 'graph') setView('map');
    M.hideCard = null; M.photoIdx = 0; H().selectNode(String(id));
    requestAnimationFrame(() => { resize(); flyTo(g.lat, g.lng, Math.max(M.z, 15)); sync(true); });
  }
  async function removeLocation(id) {
    const node = nodeById(id); if (!node) return;
    const ok = await H().confirmDialog({ title: 'إزالة الموقع؟', subject: { name: H().labelOf(node), sub: typeLabelOf(node), color: colorOf(node) }, message: 'سيُحذف الموقع وصوره من هذا الكيان، ولن يظهر على الخريطة الجغرافية. الكيان نفسه يبقى.', hint: 'يمكنك التراجع بالضغط على Ctrl+Z.', confirmText: 'إزالة الموقع' });
    if (!ok) return;
    const raw = hostState().data.nodes.find(n => String(n.id) === String(id)); G.clearGeo(raw);
    H().refreshAfterMutation('تمت إزالة الموقع', String(id), { keepView: true });
  }

  // ---- lightbox --------------------------------------------------------------------------------------
  let lb = { photos: [], i: 0 };
  function lightbox(photos, i) {
    lb = { photos, i: i || 0 };
    let box = $('#geo-lightbox');
    if (!box) {
      box = document.createElement('div'); box.id = 'geo-lightbox'; box.className = 'geo-lightbox';
      box.innerHTML = '<button type="button" class="icon-btn geo-lb-close" aria-label="إغلاق">×</button><button type="button" class="geo-nav prev" data-d="-1" aria-label="السابقة">' + ICON.chev + '</button><figure><img alt=""><figcaption></figcaption></figure><button type="button" class="geo-nav next" data-d="1" aria-label="التالية">' + ICON.chev + '</button>';
      document.body.append(box);
      box.addEventListener('click', e => {
        const n = e.target.closest('.geo-nav');
        if (n) { lb.i = (lb.i + Number(n.dataset.d) + lb.photos.length) % lb.photos.length; paintLb(); return; }
        if (!e.target.closest('figure') || e.target.closest('.geo-lb-close')) box.classList.remove('open');
      });
    }
    paintLb(); box.classList.add('open');
  }
  function paintLb() {
    const box = $('#geo-lightbox'), p = lb.photos[lb.i]; if (!p) return;
    box.querySelector('img').src = p.src; box.querySelector('figcaption').textContent = (p.caption ? p.caption + ' · ' : '') + `${lb.i + 1} / ${lb.photos.length}`;
    $$('.geo-nav', box).forEach(b => { b.hidden = lb.photos.length < 2; });
  }

  // ---- location panel inside the Details tab ---------------------------------------------------------
  function locationPanel(id) {
    const node = nodeById(id), g = node && G.geoOf(node);
    if (!node) return { has: false, html: '' };
    if (!g) return { has: false, html: `<div class="geo-empty-panel"><p class="empty-note">لا يوجد موقع جغرافي لهذا الكيان. أضف موقعًا ليظهر على الخريطة مع صوره وبياناته.</p><button type="button" class="primary-btn" data-geo-add>${ICON.pin}<span>إضافة موقع</span></button></div>` };
    return { has: true, html: `<div class="geo-panel" data-geo-id="${esc(id)}"><button type="button" class="primary-btn geo-show" data-geo-show>${ICON.map}<span>عرض على الخريطة</span></button>${locationBody(node, g, { compact: true, remove: true })}</div>` };
  }
  function wirePanel(root, id) {
    id = String(id);
    const add = $('[data-geo-add]', root); if (add) add.addEventListener('click', () => openLocEditor({ nodeId: id }));
    const jump = $('[data-geo-jump]', root); if (jump) jump.addEventListener('click', () => showOnMap(id));
    const panel = $('.geo-panel', root);
    if (panel) bindLocationActions(panel, id, () => { const dc = $('#detail-content'); const tab = $('[data-panel="location"]', dc); if (tab) { tab.innerHTML = locationPanel(id).html; wirePanel(tab, id); } });
  }

  // ---- add / edit location ---------------------------------------------------------------------------
  function ensureModal(idv) {
    let m = $('#' + idv); if (m) return m;
    m = document.createElement('div'); m.id = idv; m.className = 'ev-modal ev-modal-top';
    m.innerHTML = `<div class="ev-backdrop" data-m-close></div><section class="ev-card ev-editor" role="dialog" aria-modal="true"><header class="ev-head"><div><h2></h2><p></p></div><button type="button" class="icon-btn" data-m-close aria-label="إغلاق">×</button></header><form novalidate></form></section>`;
    document.body.append(m);
    m.addEventListener('click', e => { if (e.target.closest('[data-m-close]')) m.classList.remove('open'); });
    return m;
  }
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;
  const PHOTO_CHARS = 2.4e6;

  // Shared by entity and event editors. Each instance owns its photo draft and DOM.
  function mountLocationFields(container, initialGeo, opts = {}) {
    const h = H(), d = initialGeo ? JSON.parse(JSON.stringify(initialGeo)) : { lat: '', lng: '', place: '', address: '', note: '', photos: [] };
    d.photos = d.photos || [];
    container.innerHTML = `
      <div class="ev-grid">
        <div class="editor-field wide"><span>ابحث عن مكان (يتطلب إنترنت ويرسل نص البحث إلى خدمة خارجية؛ لا تُدخل بيانات حساسة)</span><div class="geo-search-row"><input id="gx-q" type="search" placeholder="مثال: Central Park, New York" autocomplete="off"><button type="button" class="secondary-btn" id="gx-search">بحث</button></div><div class="geo-results" id="gx-results" hidden></div></div>
        <label class="editor-field wide"><span>الإحداثيات * <small>(خط العرض، خط الطول)</small></span><div class="geo-search-row"><input id="gx-coords" dir="ltr" placeholder="40.78500, -73.96830" value="${d.lat !== '' && d.lng !== '' ? esc(G.formatCoord(Number(d.lat), Number(d.lng))) : ''}" autocomplete="off"><button type="button" class="secondary-btn" id="gx-pick">${ICON.pin}<span>اختيار من الخريطة</span></button></div></label>
        <label class="editor-field"><span>اسم المكان</span><input id="gx-place" value="${esc(d.place)}" maxlength="200" placeholder="مثال: ميناء الشمال" autocomplete="off"></label>
        <label class="editor-field"><span>العنوان</span><input id="gx-addr" value="${esc(d.address)}" maxlength="300" autocomplete="off"></label>
        <label class="editor-field wide"><span>وصف / ملاحظات عن الموقع</span><textarea id="gx-note" rows="3">${esc(d.note)}</textarea></label>
      </div>
      ${opts.destination ? `<section class="ev-sec"><h3>وجهة (اختياري)</h3><div class="ev-grid">
        <label class="editor-field wide"><span>إحداثيات الوجهة</span><div class="geo-search-row"><input id="gx-to-coords" dir="ltr" value="${d.to ? esc(G.formatCoord(d.to.lat, d.to.lng)) : ''}" placeholder="31.30000, 34.25000"><button type="button" class="secondary-btn" id="gx-to-pick">${ICON.pin}<span>اختيار من الخريطة</span></button></div></label>
        <label class="editor-field wide"><span>اسم الوجهة</span><input id="gx-to-place" maxlength="200" value="${esc(d.to && d.to.place || '')}"></label>
        <p class="editor-field wide" id="gx-distance" aria-live="polite"></p></div></section>` : ''}
      <section class="ev-sec"><h3>صور الموقع <small>حتى ${G.MAX_PHOTOS} صور · تُحفظ داخل البرنامج وتعمل دون اتصال</small></h3>
        <div class="ev-att-add"><button type="button" class="secondary-btn" id="gx-upload">رفع صور من الجهاز</button><input type="file" id="gx-file" accept="image/*" multiple hidden><input id="gx-url" dir="ltr" placeholder="https://… رابط صورة" autocomplete="off"><button type="button" class="chip-btn" id="gx-addurl">${ICON.plus} رابط</button></div>
        <ul class="geo-photo-grid" id="gx-photos"></ul></section>
`;
    const g = s => $(s, container), err = opts.onError || (() => {});
    const renderPhotos = () => {
      g('#gx-photos').innerHTML = d.photos.map((p, i) => `<li><img alt="" src="${esc(p.src)}" referrerpolicy="no-referrer"><input data-cap="${i}" value="${esc(p.caption)}" placeholder="وصف الصورة" aria-label="وصف الصورة ${i + 1}" maxlength="200"><span class="geo-photo-tools">${i ? `<button type="button" class="chip-btn" data-cover="${i}">اجعلها الغلاف</button>` : '<span class="geo-cover-badge">الغلاف</span>'}<button type="button" class="chip-btn" data-rm="${i}">إزالة</button></span></li>`).join('') || '<li class="empty-note">لا توجد صور بعد.</li>';
      $$('[data-rm]', container).forEach(b => b.addEventListener('click', () => { d.photos.splice(Number(b.dataset.rm), 1); renderPhotos(); }));
      $$('[data-cover]', container).forEach(b => b.addEventListener('click', () => { const [p] = d.photos.splice(Number(b.dataset.cover), 1); d.photos.unshift(p); renderPhotos(); }));
      $$('[data-cap]', container).forEach(inp => inp.addEventListener('input', () => { d.photos[Number(inp.dataset.cap)].caption = inp.value; }));
    };
    renderPhotos();
    g('#gx-upload').addEventListener('click', () => g('#gx-file').click());
    g('#gx-file').addEventListener('change', async e => {
      const problems = [];
      for (const f of [...e.target.files]) {
        if (d.photos.length >= G.MAX_PHOTOS) { problems.push(`الحد الأقصى ${G.MAX_PHOTOS} صور.`); break; }
        if (!/^image\//.test(f.type)) { problems.push(`«${f.name}» ليس صورة.`); continue; }
        try { const src = await h.downscaleImage(await h.readFileAsDataUrl(f), 1280); if (src.length > PHOTO_CHARS) { problems.push(`«${f.name}» كبيرة جدًا.`); continue; } d.photos.push({ src, caption: '' }); }
        catch (_) { problems.push(`تعذر قراءة «${f.name}».`); }
      }
      e.target.value = ''; renderPhotos(); err(problems);
    });
    g('#gx-addurl').addEventListener('click', async () => {
      const url = safeUrl(g('#gx-url').value); if (!url) { err(['أدخل رابط صورة صالحًا يبدأ بـ http أو https.']); return; }
      if (d.photos.length >= G.MAX_PHOTOS) { err([`الحد الأقصى ${G.MAX_PHOTOS} صور.`]); return; }
      let src = url, note = '';
      try { if (h.fetchPhotoCopy) src = await h.fetchPhotoCopy(url); } catch (_) { note = 'تعذر تنزيل نسخة للعمل دون اتصال؛ سيُحفظ الرابط فقط.'; }
      d.photos.push({ src, caption: '' }); g('#gx-url').value = ''; renderPhotos(); err(note ? [note] : []);
    });
    g('#gx-coords').addEventListener('input', () => { const c = G.parseCoords(g('#gx-coords').value); if (c) { d.lat = c.lat; d.lng = c.lng; } });
    // place search (Nominatim; needs internet)
    g('#gx-search').addEventListener('click', async () => {
      const q = g('#gx-q').value.trim(), box = g('#gx-results'); if (!q) return;
      box.hidden = false; box.innerHTML = '<p class="empty-note">جارٍ البحث…</p>';
      try {
        const list = await searchPlaces(q);
        box.innerHTML = list.length ? list.map((r, i) => `<button type="button" data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.display)}</small></button>`).join('') : '<p class="empty-note">لا توجد نتائج.</p>';
        $$('button', box).forEach(b => b.addEventListener('click', () => { const r = list[Number(b.dataset.i)]; d.lat = r.lat; d.lng = r.lng; g('#gx-coords').value = G.formatCoord(r.lat, r.lng); if (!g('#gx-place').value) g('#gx-place').value = r.name; if (!g('#gx-addr').value) g('#gx-addr').value = r.display; box.hidden = true; }));
      } catch (e) { box.innerHTML = e.code === 'sensitive_query' ? '<p role="alert">لا يُرسل البحث عبر الإنترنت لأنه يتضمن بيانات حساسة محفوظة.</p>' : '<p class="empty-note">تعذر البحث: يلزم اتصال بالإنترنت. يمكنك إدخال الإحداثيات يدويًا أو اختيار النقطة من الخريطة.</p>'; }
    });
    g('#gx-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); g('#gx-search').click(); } });
    g('#gx-pick').addEventListener('click', () => {
      if (opts.onPick) opts.onPick(pt => {
        if (pt) { d.lat = pt.lat; d.lng = pt.lng; g('#gx-coords').value = G.formatCoord(pt.lat, pt.lng); g('#gx-coords').dispatchEvent(new Event('input')); }
      });
    });
    const updateDistance = () => {
      if (!opts.destination) return;
      const a = G.parseCoords(g('#gx-coords').value), b = G.parseCoords(g('#gx-to-coords').value);
      g('#gx-distance').textContent = a && b ? `المسافة: ${G.formatDistance(G.haversine(a, b))}` : '';
    };
    if (opts.destination) {
      g('#gx-coords').addEventListener('input', updateDistance);
      g('#gx-to-coords').addEventListener('input', updateDistance);
      g('#gx-to-pick').addEventListener('click', () => {
        if (opts.onPick) opts.onPick(pt => { if (pt) g('#gx-to-coords').value = G.formatCoord(pt.lat, pt.lng); updateDistance(); });
      });
      updateDistance();
    }
    const read = () => {
      const coords = g('#gx-coords').value.trim();
      if (!coords) return null;
      const c = G.parseCoords(coords);
      if (!c) return null;
      const dest = opts.destination ? G.parseCoords(g('#gx-to-coords').value) : d.to;
      const to = dest ? { ...dest, place: opts.destination ? g('#gx-to-place').value : dest.place } : undefined;
      return G.normalizeGeo({ ...c, place: g('#gx-place').value, address: g('#gx-addr').value, note: g('#gx-note').value, photos: d.photos, to });
    };
    const validate = (required = false) => {
      const text = g('#gx-coords').value.trim();
      const destText = opts.destination ? g('#gx-to-coords').value.trim() : '';
      const hasDestination = opts.destination && (destText || g('#gx-to-place').value.trim());
      const hasFields = ['#gx-place', '#gx-addr', '#gx-note'].some(id => g(id).value.trim()) || d.photos.length > 0 || hasDestination;
      const errors = [];
      if ((required || text || hasFields) && !G.parseCoords(text)) errors.push('أدخل إحداثيات صالحة مثل: 40.78500, -73.96830 — أو اختر النقطة من الخريطة.');
      if (hasDestination && !G.parseCoords(destText)) errors.push('أدخل إحداثيات وجهة صالحة أو أزل الوجهة.');
      return errors;
    };
    const clear = () => {
      d.photos = [];
      ['#gx-coords', '#gx-place', '#gx-addr', '#gx-note', ...(opts.destination ? ['#gx-to-coords', '#gx-to-place'] : [])].forEach(id => { g(id).value = ''; });
      d.to = undefined; renderPhotos(); updateDistance();
    };
    return { read, validate, clear, destroy: () => { container.innerHTML = ''; } };
  }

  // ctx: { nodeId?, at?: {lat,lng} }  — nodeId set: edit that entity's location; otherwise choose/create an entity.
  function openLocEditor(ctx) {
    const h = H(), m = ensureModal('geo-edit'), form = $('form', m);
    const node = ctx.nodeId ? nodeById(ctx.nodeId) : null, had = node ? G.geoOf(node) : null;
    const d = ctx.draft || (had ? JSON.parse(JSON.stringify(had)) : { lat: ctx.at ? ctx.at.lat : '', lng: ctx.at ? ctx.at.lng : '', place: '', address: '', note: '', photos: [] });
    d.photos = d.photos || [];
    $('h2', m).textContent = node ? (had ? 'تعديل الموقع' : 'إضافة موقع') : 'موقع جديد على الخريطة';
    $('header p', m).textContent = node ? `${h.labelOf(node)} · ${typeLabelOf(node)}` : 'اختر كيانًا موجودًا أو أنشئ كيانًا جديدًا ثم حدّد مكانه';
    const free = h.state.nodes.filter(n => !G.geoOf(n)).sort((a, b) => h.labelOf(a).localeCompare(h.labelOf(b), 'ar'));
    const types = Object.entries(h.TYPE_AR || {}).filter(([k]) => k !== 'Event');
    form.innerHTML = `
      <div class="ev-grid">
        ${node ? '' : `<label class="editor-field wide"><span>الكيان صاحب الموقع *</span><select id="gx-entity"><option value="__new__">＋ كيان جديد…</option>${free.map(n => opt(n.id, `${h.labelOf(n)} · ${typeLabelOf(n)}`, ctx.entityId === String(n.id))).join('')}</select></label>
        <label class="editor-field" id="gx-newname-wrap"><span>اسم الكيان الجديد *</span><input id="gx-newname" maxlength="200" autocomplete="off"></label>
        <label class="editor-field" id="gx-newtype-wrap"><span>نوع الكيان</span><select id="gx-newtype">${types.map(([k, v]) => opt(k, v, k === 'Location' || k === 'Place')).join('')}</select></label>`}
      </div>
      <div id="gx-fields"></div>
      <div class="ev-errors" id="gx-errors" role="alert" hidden></div>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-m-close>إلغاء</button><button type="submit" class="primary-btn">حفظ الموقع</button></div>`;
    const g = s => $(s, form);
    const err = msgs => { const b = g('#gx-errors'); b.hidden = !msgs.length; b.innerHTML = msgs.map(x => `<p>${esc(x)}</p>`).join(''); if (msgs.length) b.scrollIntoView({ block: 'nearest' }); };
    const syncNew = () => { if (node) return; const isNew = g('#gx-entity').value === '__new__'; g('#gx-newname-wrap').hidden = g('#gx-newtype-wrap').hidden = !isNew; };
    if (!node) { g('#gx-entity').addEventListener('change', syncNew); syncNew(); }
    const fields = mountLocationFields(g('#gx-fields'), d, { onError: err, onPick: done => {
      m.classList.remove('open');
      startPick(pt => { done(pt); m.classList.add('open'); });
    } });
    if (ctx.restore) { const r = ctx.restore; if (!node) { g('#gx-entity').value = r.entity; g('#gx-newname').value = r.newname; g('#gx-newtype').value = r.newtype; syncNew(); } if (r.coordsText !== undefined && r.lat !== '') g('#gx-coords').value = G.formatCoord(Number(r.lat), Number(r.lng)); }
    form.onsubmit = e => {
      e.preventDefault();
      const errors = fields.validate(true); if (errors.length) { err(errors); return; }
      const raw = fields.read(), c = raw;
      const size = JSON.stringify({ n: h.state.data.nodes, e: h.state.data.edges }).length + raw.photos.reduce((s, p) => s + p.src.length, 0);
      if (size > 12 * 1024 * 1024) { err(['حجم البيانات مع الصور كبير جدًا؛ احذف بعض الصور أو استخدم صورًا أصغر.']); return; }
      let target = node ? h.state.data.nodes.find(n => String(n.id) === String(node.id)) : null, createdNew = false;
      if (!node) {
        const sel = g('#gx-entity').value;
        if (sel === '__new__') {
          const name = g('#gx-newname').value.trim(); if (!name) { err(['اكتب اسم الكيان الجديد.']); return; }
          target = { id: h.nextId(h.state.data.nodes), label: name, labelEn: '', schema: g('#gx-newtype').value, status: 'active', summary: '', photo: '', country: '', url: '', legalForm: '', boundary: false, subjects: [], attributes: {} };
          h.state.data.nodes.push(target); createdNew = true;
        } else target = h.state.data.nodes.find(n => String(n.id) === String(sel));
      }
      if (!target) { err(['الكيان غير موجود.']); return; }
      G.applyGeo(target, raw);
      m.classList.remove('open');
      M.hideCard = null; M.photoIdx = 0;
      h.refreshAfterMutation(createdNew ? `تمت إضافة «${target.label}» على الخريطة` : `تم حفظ موقع «${target.label}»`, String(target.id), { keepView: true });
      if (M.view === 'graph' && !ctx.stayInGraph) { /* stay where the user was */ } else { requestAnimationFrame(() => { resize(); flyTo(c.lat, c.lng, Math.max(M.z, 15)); sync(true); }); }
    };
    m.classList.add('open'); setTimeout(() => (node ? g('#gx-q') : g('#gx-entity'))?.focus(), 30);
  }
  async function searchPlaces(q) {
    if (window.RelationshipProfile?.hasSensitiveQuery(hostState().data.nodes, q)) { const e = new Error('لا يُرسل البحث عبر الإنترنت لأنه يتضمن بيانات حساسة محفوظة.'); e.code = 'sensitive_query'; throw e; }
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ar&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('search failed');
    return (await r.json()).map(x => ({ lat: Number(x.lat), lng: Number(x.lon), name: x.name || String(x.display_name || '').split(',')[0], display: x.display_name || '' })).filter(x => G.validLatLng(x.lat, x.lng));
  }

  // ---- pick on map / measure -------------------------------------------------------------------------
  function toolBusyNotice() {
    H().setStatus('أكمل الأداة الحالية أو أغلقها قبل بدء أداة أخرى.', false);
    if (el.banner && !el.banner.hidden) {
      let note = $('.geo-tool-warning', el.banner);
      if (!note) { note = document.createElement('span'); note.className = 'geo-tool-warning'; note.setAttribute('role', 'status'); el.banner.append(note); }
      note.textContent = 'أغلق الأداة الحالية أولًا.';
    }
  }
  function startPick(cb) {
    if (M.pick || M.measure || M.zoneDraw || M.zoneEdit) { toolBusyNotice(); if (cb) cb(null); return; }
    closeMapPopovers();
    if (M.view === 'graph') setView('map');
    M.pick = cb; el.frame.classList.add('picking');
    banner('انقر لتحديد الموقع، أو حرّك المركز بالأسهم واضغط Enter — Esc للإلغاء', [['إلغاء', () => endPick(null)]]);
    requestAnimationFrame(() => { resize(); el.canvas.focus({ preventScroll: true }); });
  }
  function endPick(pt) { const cb = M.pick; M.pick = null; el.frame.classList.remove('picking'); banner(''); if (cb) cb(pt); }
  function positionToolBanner() {
    if (!el.frame) return;
    let bottom = 56;
    if (el.timebar && !el.timebar.hidden) {
      const f = el.frame.getBoundingClientRect(), t = el.timebar.getBoundingClientRect();
      bottom = Math.max(bottom, f.bottom - t.top + 10);
    }
    el.frame.style.setProperty('--geo-banner-bottom', `${Math.ceil(bottom)}px`);
    const f = el.frame.getBoundingClientRect(), hud = $('.geo-hud', el.frame), b = el.banner;
    if (hud && b && !b.hidden) {
      let top = Math.max(56, hud.getBoundingClientRect().bottom - f.top + 10);
      let bannerTop = f.bottom - b.getBoundingClientRect().top + 10;
      const open = (el.layers && !el.layers.hidden) || (el.filters && !el.filters.hidden);
      const compact = !!open && !!(M.pick || M.measure || M.zoneDraw || M.zoneEdit) && f.height - top - bannerTop < 120;
      el.frame.classList.toggle('geo-tool-compact', compact);
      if (compact) { top = Math.min(top, Math.max(0, f.height - 100)); bannerTop = Math.min(56, Math.max(10, f.height - top - 80)); }
      el.frame.style.setProperty('--geo-popup-top', `${Math.ceil(top)}px`);
      el.frame.style.setProperty('--geo-popup-bottom', `${Math.ceil(bannerTop)}px`);
    }
  }
  function banner(text, actions = []) {
    positionToolBanner();
    const b = el.banner; b.hidden = !text; b.innerHTML = text ? `<span aria-live="polite">${esc(text)}</span>` : '';
    actions.forEach(([label, fn]) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'chip-btn'; x.textContent = label; x.addEventListener('click', fn); b.append(x); });
  }
  function toggleMeasure() {
    if (M.measure) { stopMeasure(); return; }
    if (M.pick || M.zoneDraw || M.zoneEdit) { toolBusyNotice(); return; }
    closeMapPopovers();
    M.measure = { pts: [], cursor: null, done: false }; el.measureBtn.setAttribute('aria-pressed', 'true'); el.frame.classList.add('measuring'); updateMeasure(); requestAnimationFrame(() => el.canvas.focus({ preventScroll: true }));
  }
  function stopMeasure() { M.measure = null; el.measureBtn.setAttribute('aria-pressed', 'false'); el.frame.classList.remove('measuring'); banner(''); schedule(); }
  function updateMeasure() {
    const me = M.measure; if (!me) return;
    const pts = me.cursor && !me.done ? me.pts.concat([me.cursor]) : me.pts;
    const len = G.pathLength(pts), area = me.pts.length >= 3 ? G.polygonArea(me.pts) : 0;
    const txt = me.pts.length ? `المسافة: ${G.formatDistance(len)}${area ? ` · المساحة: ${G.formatArea(area)}` : ''}` : 'انقر لإضافة نقاط القياس — أو حرّك المركز بالأسهم واضغط مسافة؛ Enter للإنهاء';
    banner(txt, [['مسح', () => { me.pts = []; me.done = false; updateMeasure(); schedule(); }], ['إغلاق', stopMeasure]]);
  }

  // ---- HUD -------------------------------------------------------------------------------------------
  function updateScale() {
    const mpp = G.metersPerPixel(M.lat, M.z), dist = G.niceDistance(mpp * 110), px = dist / mpp;
    el.scaleBar.style.width = px + 'px'; el.scaleTxt.textContent = G.formatDistance(dist);
  }
  function updateHud(areaRect) {
    if (M.cursor) el.coords.textContent = G.formatCoord(M.cursor.lat, M.cursor.lng);
    const hasMap = Boolean(M.area || M.base || (M.tileInfo && M.tileInfo.available));
    const none = !hasMap && !pins().length;
    el.empty.hidden = !none;
    if (raster) raster.syncUI();
    // The «vector map is not ready yet» hint only shows while there is genuinely no vector map and the
    // vector basemap is selected; the raster map (or the plain background) keeps everything usable.
    const noBase = !M.base;
    el.zoomNote.hidden = !(noBase && (M.basemap === 'vector' || M.basemap === 'hybrid'));
    if (!el.zoomNote.hidden && el.zoomNoteText) {
      el.zoomNoteText.textContent = M.vectorStatus === 'downloading'
        ? 'خريطة الشوارع قيد التجهيز — الخريطة المحمّلة تعمل الآن'
        : M.vectorStatus === 'preparing'
          ? 'جارٍ تجهيز خريطة الشوارع…'
          : 'لم تُنزَّل بيانات خريطة الشوارع بعد';
    }
    refreshVectorNote();
    if (el.outsideHint) {
      const outside = Boolean(M.area && areaRect && R && R.isRectOutsideView(areaRect, M.w, M.h, 24));
      el.outsideHint.hidden = !outside;
      if (outside) el.outsideTxt.textContent = `العرض خارج ${M.area.name || 'حدود المنطقة'}`;
    }
  }

  // ---- interaction -----------------------------------------------------------------------------------
  function bindInteraction() {
    const c = el.canvas, pts = new Map(); let drag = null, pinch = null, zoneDrag = null;
    const rel = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (M.zoneEdit) {
        const p = rel(e), vertices = zoneVertices(M.zoneEdit);
        const hit = vertices.find(v => Math.hypot(v.x - p.x, v.y - p.y) <= 13);
        if (hit) { M.zoneVertex = vertices.indexOf(hit); zoneDrag = hit.key; zoneEditBanner(); c.setPointerCapture(e.pointerId); return; }
        if (M.zoneEdit.shape === 'polygon') {
          const poly = vertices;
          for (let i = 0; i < poly.length; i++) {
            if (segmentDistance(p, poly[i], poly[(i + 1) % poly.length]) <= 10) {
              const pt = fromScreen(p.x, p.y); M.zoneEdit.points.splice(i + 1, 0, { lat: round6(pt.lat), lng: round6(pt.lng) }); M.zoneVertex = i + 1; zoneEditBanner(); zoneDrag = i + 1; c.setPointerCapture(e.pointerId); schedule(); return;
            }
          }
        }
        return;
      }
      c.setPointerCapture(e.pointerId); pts.set(e.pointerId, rel(e)); cancelAnimationFrame(M.fly);
      if (pts.size === 1) drag = { start: rel(e), moved: 0, last: rel(e) };
      else if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: M.z }; drag = null; }
    });
    c.addEventListener('pointermove', e => {
      const p = rel(e); M.cursor = fromScreen(p.x, p.y); el.coords.textContent = G.formatCoord(M.cursor.lat, M.cursor.lng);
      if (M.zoneDraw) schedule();
      if (M.zoneEdit && zoneDrag !== null) {
        const pt = { lat: round6(M.cursor.lat), lng: round6(M.cursor.lng) };
        if (zoneDrag === 'center') M.zoneEdit.center = pt;
        else if (zoneDrag === 'radius') M.zoneEdit.radius = Math.max(1, G.haversine(M.zoneEdit.center, pt));
        else M.zoneEdit.points[zoneDrag] = pt;
        schedule(); return;
      }
      if (M.measure && !M.measure.done) { M.measure.cursor = M.cursor; updateMeasure(); schedule(); }
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.z + Math.log2(d / Math.max(10, pinch.d))); return; }
      if (drag) { const dx = p.x - drag.last.x, dy = p.y - drag.last.y; drag.moved += Math.abs(dx) + Math.abs(dy); drag.last = p; if (drag.moved > 4) { c.classList.add('dragging'); panBy(dx, dy); } }
    });
    const up = e => {
      if (zoneDrag !== null) { zoneDrag = null; return; }
      const wasDrag = drag && drag.moved <= 4, p = rel(e); pts.delete(e.pointerId); c.classList.remove('dragging');
      if (pts.size < 2) pinch = null;
      if (wasDrag && e.type === 'pointerup') mapClick(p);
      if (!pts.size) drag = null;
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); const p = rel(e); zoomAt(p.x, p.y, M.z - Math.max(-120, Math.min(120, e.deltaY)) * 0.0022); }, { passive: false });
    c.addEventListener('dblclick', e => { const p = rel(e); if (M.zoneDraw && M.zoneDraw.shape === 'polygon') { const d = M.zoneDraw, last = d.points[d.points.length - 1], prev = d.points[d.points.length - 2]; if (last && prev && G.haversine(last, prev) < 1) d.points.pop(); finishZoneDraw(); return; } if (M.measure) { M.measure.done = true; M.measure.pts.pop(); updateMeasure(); schedule(); return; } if (!M.pick && !M.zoneEdit) zoomAt(p.x, p.y, M.z + 1); });
    c.addEventListener('contextmenu', e => { e.preventDefault(); const p = rel(e);
      if (M.zoneEdit) { if (M.zoneEdit.shape === 'polygon' && M.zoneEdit.points.length > 3) { const hit = zoneVertices(M.zoneEdit).find(v => Math.hypot(v.x - p.x, v.y - p.y) <= 13); if (hit) { M.zoneEdit.points.splice(hit.key, 1); M.zoneVertex = Math.min(M.zoneVertex, M.zoneEdit.points.length - 1); zoneEditBanner(); } schedule(); } return; }
      if (M.zoneDraw || M.pick || M.measure) return;
      const pt = fromScreen(p.x, p.y); openLocEditor({ at: { lat: round6(pt.lat), lng: round6(pt.lng) } }); });
    c.addEventListener('keydown', e => {
      const k = e.key, step = 80;
      if (M.zoneEdit && editZoneWithKeyboard(e)) return;
      if (k === 'Enter' && M.zoneDraw && M.zoneDraw.shape === 'polygon') { e.preventDefault(); e.stopPropagation(); finishZoneDraw(); return; }
      if ((k === ' ' || k === 'Enter') && (M.pick || M.zoneDraw || M.measure)) {
        e.preventDefault(); e.stopPropagation();
        if (k === 'Enter' && M.measure) { M.measure.done = true; updateMeasure(); schedule(); }
        else { M.cursor = fromScreen(M.w / 2, M.h / 2); if (M.measure) M.measure.cursor = M.cursor; mapClick({ x: M.w / 2, y: M.h / 2 }); }
        return;
      }
      if ((M.pick || M.zoneDraw || M.zoneEdit || M.measure) && !e.ctrlKey && !e.metaKey && ['Delete', 'Backspace', 'e', 'E', 'r', 'R'].includes(k)) { e.preventDefault(); e.stopPropagation(); return; }
      if (k === 'ArrowLeft') panBy(step, 0); else if (k === 'ArrowRight') panBy(-step, 0); else if (k === 'ArrowUp') panBy(0, step); else if (k === 'ArrowDown') panBy(0, -step);
      else if (k === '+' || k === '=') zoomAt(M.w / 2, M.h / 2, M.z + 0.5); else if (k === '-') zoomAt(M.w / 2, M.h / 2, M.z - 0.5); else return;
      if (M.pick || M.zoneDraw || M.measure) { M.cursor = fromScreen(M.w / 2, M.h / 2); if (M.measure && !M.measure.done) { M.measure.cursor = M.cursor; updateMeasure(); } schedule(); }
      e.preventDefault(); e.stopPropagation();
    });
    el.pins.addEventListener('click', onPinsClick);
  }
  function mapClick(p) {
    const pt = fromScreen(p.x, p.y);
    if (M.pick) { endPick({ lat: round6(pt.lat), lng: round6(pt.lng) }); return; }
    if (M.zoneDraw) { zoneDrawClick(pt); return; }
    if (M.zoneEdit) return;
    if (M.measure) { if (M.measure.done) M.measure.pts = [], M.measure.done = false; M.measure.pts.push({ lat: pt.lat, lng: pt.lng }); updateMeasure(); schedule(); return; }
    const route = hitRoute(p);
    if (route) { H().selectNode(String(route.node.id)); M.activeEvent = route.key; M.hideCard = null; M.photoIdx = 0; sync(true); return; }
    if (M.layers.zones && M.filters.kinds.zones) {
      const zone = [...(hostState().data.zones || [])].reverse().find(z => zoneContains(z, pt));
      if (zone) { M.activeZone = String(zone.id); M.activeEvent = null; M.photoIdx = 0; M.hideCard = null; renderCard(); return; }
    }
    M.activeZone = null; el.card.hidden = true;
    // empty map click: close the card (selection stays in the graph)
    if (M.selected) { M.hideCard = M.activeEvent || M.selected; el.card.hidden = true; }
    if (hostState().selected && $('#hide-panel-switch')?.checked) { const b = $('#clear-selection'); if (b) b.click(); }
  }
  const round6 = v => Math.round(v * 1e6) / 1e6;

  // ---- area setup + offline vector basemap (1B.3) -----------------------------------------------------
  // Overpass mirrors, best first: the French instance answers the Gaza extract in a few seconds, the
  // others are retried only when it fails (overpass-api.de often replies 502 when at capacity).
  const OVERPASS = [
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const BUILTIN_NAME = 'منطقة غزة';
  const SERVER_MAP_URL = '/api/vectormap';
  const SERVER_MAP_INFO_URL = '/api/vectormap/info';

  // Turns the server tile-pack bounds into the fixed built-in working area (no area picking needed).
  function builtinAreaFrom(info) {
    const b = info && info.available && info.bounds ? info.bounds : null;
    const bounds = b && G.validLatLng(b.s, b.w) && G.validLatLng(b.n, b.e) ? b : G.GAZA_BOUNDS;
    return G.builtinGazaArea({ s: bounds.s, w: bounds.w, n: bounds.n, e: bounds.e }, BUILTIN_NAME);
  }

  // Splits a bbox into 1x1 / 2x2 / 3x3 sub-requests, downloading them one after another with progress,
  // retrying on the next Overpass mirror, then merging with de-duplication by OSM id.
  async function fetchBasemap(bbox, detail, onStatus, signal) {
    return Download.fetchBasemap({ bbox, detail, geo: G, mirrors: OVERPASS, fetcher: window.fetch.bind(window), onStatus, signal });
  }

  async function installBasemap(raw, area, opts = {}) {
    G.validateBasemap(raw);
    const target = { ...area, id: area.builtin ? AreaStore.BUILTIN : (area.id || freshAreaId()), builtin: !!area.builtin };
    let activate = opts.activate !== false;
    const inflated = G.inflate(raw);
    if (M.areaStorageReady) {
      const saved = await areaStore.putArea(target, raw, activate, opts.expectedActiveId || null);
      activate = saved.activated && (!opts.expectedActiveId || M.activeAreaId === opts.expectedActiveId);
      const current = M.areas.findIndex(a => a.id === target.id);
      if (current < 0) M.areas.push(target); else M.areas[current] = target;
    } else {
      throw new Error('التخزين الدائم غير متاح؛ بقيت الخريطة السابقة دون تغيير.');
    }
    if (!activate) return;
    M.base = inflated; M.area = target; M.activeAreaId = target.id;
    if (!M.positioned) { resize(); M.positioned = true; initialPosition(); }
    if (raster && !M.savedBasemap && M.basemap !== 'vector') raster.setBasemap('vector', false);
    if (raster) raster.syncUI();
    schedule(); updateHud(); refreshVectorNote();
  }

  function setVectorStatus(status, note) {
    M.vectorStatus = status;
    if (note !== undefined) M.vectorNote = note;
    refreshVectorNote();
    if (raster) raster.syncUI();
    if (el.frame) schedule();
  }

  // Small non-blocking chips: «جارٍ تجهيز خريطة الشوارع…» / «الجزء 2 من 4» and the v1 update notice.
  function refreshVectorNote() {
    if (!el.frame || !el.vectorNote) return;
    const n = el.vectorNote;
    const updateNeeded = M.base && M.base.v === 1;
    const busy = ['preparing', 'downloading'].includes(M.vectorStatus);
    const text = M.vectorNote || (busy ? 'جارٍ تجهيز خريطة الشوارع…' : '');
    const showText = Boolean(text) && (busy || M.vectorStatus !== 'ready');
    n.querySelector('[data-vec-text]').textContent = showText ? text : '';
    n.querySelector('[data-vec-text]').hidden = !showText;
    const btn = n.querySelector('[data-vec-update]');
    btn.hidden = !updateNeeded || busy;
    btn.textContent = 'تحديث الخريطة لعرض المزيد من الأسماء';
    n.dataset.state = busy ? 'busy' : updateNeeded ? 'outdated' : 'idle';
    n.hidden = !showText && !updateNeeded;
    n.setAttribute('aria-live', 'polite');
  }

  // ---- server-served bundled map (`/api/vectormap`) ---------------------------------------------------
  async function fetchServerMapInfo() {
    try {
      const r = await fetch(SERVER_MAP_INFO_URL, { credentials: 'same-origin', cache: 'no-store' });
      M.vectorServerStatus = r.status;
      // Before sign-in every /api route answers 401: wait for the session instead of falling back to Overpass.
      if (r.status === 401 || r.status === 403) { M.vectorNeedsAuth = true; return null; }
      M.vectorNeedsAuth = false;
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { M.vectorServerStatus = 0; M.vectorNeedsAuth = false; return null; }
  }
  async function fetchServerMap() {
    const r = await fetch(SERVER_MAP_URL, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const raw = await r.json();
    G.validateBasemap(raw);
    return raw;
  }

  // 1B.3 automatic install: silently keeps a stored copy up to date with the bundled file, replacing the
  // stored map only after the new download has been validated. Never prompts and never blocks the app.
  async function autoInstallVectorMap(opts = {}) {
    const force = Boolean(opts.force);
    // `force` (the «تحديث» button / «إعادة التحميل») must be able to start even while another try is marked busy,
    // because the caller sets the busy status itself before calling in.
    if (!force && (M.vectorStatus === 'preparing' || M.vectorStatus === 'downloading')) return false;
    if (M.base && M.base.v === 2 && !force) { setVectorStatus('ready', ''); await maybeUpdateVectorMap(); return true; }

    setVectorStatus('preparing', 'جارٍ تجهيز خريطة الشوارع…');
    // 1. The bundled file served by the app (works fully offline).
    try {
      const info = await fetchServerMapInfo();
      if (info && info.available) {
        if (!force && info.hash && info.hash === M.vectorHash && M.base && M.base.v === 2) {
          setVectorStatus('ready', ''); return true;
        }
        setVectorStatus('preparing', 'جارٍ تجهيز خريطة الشوارع…');
        const raw = await fetchServerMap();
        if (raw) {
          const b = raw.bbox && G.validLatLng(raw.bbox.s, raw.bbox.w) ? raw.bbox : (M.builtinArea || G.GAZA_BOUNDS);
          const area = G.builtinGazaArea({ s: b.s, w: b.w, n: b.n, e: b.e }, BUILTIN_NAME);
          M.builtinArea = area;
          await installBasemap(raw, area, { activate: !M.area || M.area.builtin, expectedActiveId: AreaStore.BUILTIN });
          M.vectorHash = info.hash || '';
          await kvSet('vectormapHash', M.vectorHash);
          setVectorStatus('ready', '');
          return true;
        }
      }
    } catch (err) {
      M.vectorLastError = err && err.message;
    }
    if (M.vectorNeedsAuth) {
      // Not signed in yet: do nothing, the install is retried as soon as the map is opened after login.
      setVectorStatus('idle', '');
      return false;
    }

    // 2. No bundled file: download the built-in area in the background from Overpass (retried next launch).
    const area = M.builtinArea || builtinAreaFrom(M.tileInfo);
    M.builtinArea = area;
    setVectorStatus('downloading', 'جارٍ تنزيل خريطة الشوارع…');
    try {
      M.vectorAttempts += 1;
      const raw = await fetchBasemap(area.bbox, 'medium', msg => setVectorStatus('downloading', msg));
      await installBasemap(raw, area, { activate: !M.area || M.area.builtin, expectedActiveId: AreaStore.BUILTIN });
      setVectorStatus('ready', '');
      return true;
    } catch (err) {
      M.vectorLastError = err && err.message;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      setVectorStatus(offline ? 'offline' : 'error', '');
      return false;
    }
  }

  // Compares the served hash with the stored one; replaces the stored map only when the new copy loads.
  async function maybeUpdateVectorMap() {
    if (!M.base) return false;
    const info = await fetchServerMapInfo();
    if (!info) return false;
    const storedHash = M.vectorHash || (await kvGet('vectormapHash')) || '';
    if (!info.available || !info.hash || info.hash === storedHash) return false;
    if (M.base.v === 2 && info.version === M.base.v && !storedHash) return false;
    try {
      const raw = await fetchServerMap();
      if (!raw) return false;
      const b = raw.bbox && G.validLatLng(raw.bbox.s, raw.bbox.w) ? raw.bbox : M.area.bbox;
      await installBasemap(raw, G.builtinGazaArea({ s: b.s, w: b.w, n: b.n, e: b.e }, BUILTIN_NAME), { activate: !M.area || M.area.builtin, expectedActiveId: AreaStore.BUILTIN });
      M.vectorHash = info.hash;
      await kvSet('vectormapHash', M.vectorHash);
      setVectorStatus('ready', '');
      return true;
    } catch (_) { return false; }
  }

  // «تحديث الخريطة لعرض المزيد من الأسماء» — a v1 map keeps working until the v2 download succeeds.
  async function updateVectorMapFromNotice() {
    setVectorStatus('preparing', 'جارٍ تنزيل أسماء المناطق والمعالم…');
    const ok = await autoInstallVectorMap({ force: true });
    if (!ok) setVectorStatus(M.base && M.base.v === 1 ? 'outdated' : 'error', 'تعذر تحديث الخريطة الآن — ستبقى النسخة القديمة تعمل.');
    return ok;
  }

  const fmtDate = iso => { try { return new Date(iso).toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; } };
  const fmtSize = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} م.ب` : `${Math.max(1, Math.round(bytes / 1024))} ك.ب`);

  // ---- setup dialog: advanced, pre-filled with the built-in area --------------------------------------
  function openSetup() {
    const m = ensureModal('geo-setup'), form = $('form', m);
    const builtin = M.builtinArea || builtinAreaFrom(M.tileInfo);
    M.builtinArea = builtin;
    const isBuiltinArea = !M.area || M.area.builtin;
    const current = isBuiltinArea ? builtin : M.area;
    $('h2', m).textContent = 'منطقة الخريطة';
    $('header p', m).textContent = 'خريطة الشوارع جاهزة تلقائيًا لمنطقة غزة. افتح «منطقة مخصصة» فقط إذا أردت مكانًا آخر.';
    const st = M.base ? M.base.stats : null;
    const dims = G.bboxDimensionsKm(builtin.bbox);
    const est = G.estimateBasemapSize(builtin.bbox, builtin.detail);
    const savedLine = st
      ? `الخريطة المحفوظة: ${st.roads} طريق · ${st.water} مسطح مائي · ${st.green} حديقة · ${st.labels} اسم مكان${M.base.created ? ' · ' + esc(fmtDate(M.base.created)) : ''}`
      : 'لم تُجهَّز خريطة الشوارع بعد.';
    form.innerHTML = `
      <div class="geo-download-progress" id="gs-progress" hidden><span id="gs-progress-text" role="status">جارٍ تنزيل الخريطة…</span><button type="button" class="secondary-btn" id="gs-cancel">إلغاء التنزيل</button></div>
      <div class="geo-builtin-card" id="gs-builtin">
        <div class="geo-builtin-head"><strong>${esc(builtin.name)}</strong><span class="geo-builtin-badge">المنطقة الافتراضية</span></div>
        <p class="geo-builtin-meta">العرض <span dir="ltr">${dims.widthKm}</span> كم · الارتفاع <span dir="ltr">${dims.heightKm}</span> كم · <span dir="ltr">${builtin.areaKm2}</span> كم² · ${esc(est.label)} · تُنزَّل تلقائيًا وتعمل دون اتصال</p>
        <div class="geo-builtin-actions">
          <button type="button" class="primary-btn" id="gs-reload" ${M.vectorStatus === 'downloading' || M.vectorStatus === 'preparing' ? 'disabled' : ''}>إعادة التحميل</button>
          <button type="button" class="secondary-btn" data-g="area">العودة إلى المنطقة</button>
        </div>
      </div>
      <section class="ev-sec geo-saved-areas"><h3>المناطق المحفوظة</h3>
        <label class="editor-field"><span>اختر المنطقة</span><select id="gs-areas">${(M.areas.length ? M.areas : [builtin]).map(a => `<option value="${esc(a.id || AreaStore.BUILTIN)}" ${(a.id || AreaStore.BUILTIN) === M.activeAreaId ? 'selected' : ''}>${esc(a.name)}${a.builtin ? ' · افتراضية' : ''}</option>`).join('')}</select></label>
        <div class="geo-builtin-actions"><button type="button" class="secondary-btn" id="gs-switch">الانتقال إلى المنطقة</button><button type="button" class="secondary-btn danger-btn" id="gs-delete">حذف المنطقة المختارة</button></div>
        ${M.areaStorageReady ? '' : '<p class="geo-note" role="status">التخزين الدائم غير متاح؛ لا يمكن إدارة عدة مناطق حتى يُسمح بتخزين الموقع.</p>'}
      </section>
      <details class="geo-custom-area" id="gs-custom"${isBuiltinArea ? '' : ' open'}>
        <summary>منطقة مخصصة</summary>
        <div class="ev-grid">
          <label class="editor-field wide"><span>اسم المنطقة</span><input id="gs-name" maxlength="200" value="${esc(!isBuiltinArea && current ? current.name : '')}" placeholder="منطقة مخصصة"></label>
          <div class="editor-field wide"><span>ابحث عن مدينة أو منطقة (يتطلب إنترنت ويرسل نص البحث إلى خدمة خارجية؛ لا تُدخل بيانات حساسة)</span><div class="geo-search-row"><input id="gs-q" type="search" placeholder="مثال: Austin, Texas" autocomplete="off"><button type="button" class="secondary-btn" id="gs-search">بحث</button></div><div class="geo-results" id="gs-results" hidden></div></div>
          <label class="editor-field"><span>خط العرض (المركز)</span><input id="gs-lat" dir="ltr" inputmode="decimal" value="${current && !isBuiltinArea ? current.center.lat : ''}" placeholder="31.405"></label>
          <label class="editor-field"><span>خط الطول (المركز)</span><input id="gs-lng" dir="ltr" inputmode="decimal" value="${current && !isBuiltinArea ? current.center.lng : ''}" placeholder="34.395"></label>
          <label class="editor-field"><span>طول ضلع المنطقة (كم)</span><input id="gs-side" type="number" min="4" max="50" step="1" value="${current && !isBuiltinArea ? current.sideKm : 20}"></label>
          <div class="editor-field"><span>المساحة</span><output id="gs-area" class="geo-area-out">—</output></div>
          <div class="editor-field wide"><span>الحجم المتوقع للتنزيل</span><output id="gs-est" class="geo-area-out">—</output></div>
          <div class="editor-field wide"><span>مستوى التفاصيل</span><div class="ev-seg" id="gs-detail" role="radiogroup"><button type="button" role="radio" data-v="medium" aria-checked="true">متوسط: طرق وشوارع ومياه وحدائق وأسماء</button><button type="button" role="radio" data-v="basic" aria-checked="false">أساسي: طرق رئيسية فقط (أخف)</button></div></div>
        </div>
      </details>
      <div class="ev-errors geo-status" id="gs-status" role="status">${savedLine}</div>
      <section class="ev-sec"><h3>التخزين وحالة الاتصال</h3><p id="gs-network" role="status"></p><p id="gs-storage" role="status">جارٍ فحص التخزين…</p><button type="button" class="secondary-btn" id="gs-persist">طلب الاحتفاظ بالبيانات</button></section>
      <section class="ev-sec"><h3>نسخة جميع المناطق</h3><p>الاستيراد يضيف نسخًا ولا يستبدل المناطق الموجودة؛ تبقى منطقة غزة الافتراضية محمية. البيانات والعلاقات لا تُضمَّن.</p>
        <div class="ev-att-add"><button type="button" class="secondary-btn" id="gs-backup-export">تصدير جميع المناطق</button><label class="editor-field"><span>استيراد نسخة المناطق (حتى 64 ميغابايت)</span><input type="file" id="gs-backup-file" accept=".json,application/json"></label></div>
        <div id="gs-backup-preview" role="status"></div><button type="button" class="primary-btn" id="gs-backup-apply" hidden>إضافة نسخ المناطق</button></section>
      <section class="ev-sec"><h3>ملف الخريطة <small>للأجهزة دون إنترنت: صدّر الملف من جهاز متصل ثم استورده هنا</small></h3>
        <div class="ev-att-add"><button type="button" class="secondary-btn" id="gs-export" ${M.base ? '' : 'disabled'}>تصدير ملف الخريطة</button><button type="button" class="secondary-btn" id="gs-import">استيراد ملف الخريطة</button><input type="file" id="gs-file" accept=".json,application/json" hidden></div></section>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-m-close>إغلاق</button><button type="button" class="secondary-btn" id="gs-save">حفظ كمنطقة مخصصة</button><button type="submit" class="primary-btn" id="gs-go">تنزيل هذه المنطقة</button></div>`;
    const g = s => $(s, form);
    let detail = current && current.detail === 'basic' ? 'basic' : 'medium';
    const status = (t, bad) => { const s = g('#gs-status'); s.hidden = !t; s.textContent = t; s.classList.toggle('bad', !!bad); if (manualAreaDownload) g('#gs-progress-text').textContent = t; };
    const beginDownload = () => {
      if (manualAreaDownload) return null;
      const ctrl = new AbortController(); manualAreaDownload = ctrl;
      g('#gs-go').disabled = true; g('#gs-reload').disabled = true; g('#gs-save').disabled = true; g('#gs-progress').hidden = false;
      return ctrl;
    };
    const endDownload = ctrl => {
      if (manualAreaDownload !== ctrl) return;
      manualAreaDownload = null; g('#gs-go').disabled = false; g('#gs-reload').disabled = false; g('#gs-save').disabled = false; g('#gs-progress').hidden = true;
    };
    g('#gs-cancel').addEventListener('click', () => { if (manualAreaDownload) manualAreaDownload.abort(); });
    const updateAreaButtons = () => {
      const id = g('#gs-areas').value;
      g('#gs-delete').disabled = !M.areaStorageReady || id === AreaStore.BUILTIN || id === M.activeAreaId;
      g('#gs-switch').disabled = !M.areaStorageReady || id === M.activeAreaId;
    };
    g('#gs-areas').addEventListener('change', updateAreaButtons); updateAreaButtons();
    g('#gs-switch').addEventListener('click', async () => {
      if (manualAreaDownload) return;
      try { await switchWorkingArea(g('#gs-areas').value); openSetup(); }
      catch (ex) { status('تعذر تغيير المنطقة: ' + (ex.message || 'خطأ في التخزين'), true); }
    });
    g('#gs-delete').addEventListener('click', async () => {
      if (manualAreaDownload) return;
      const id = g('#gs-areas').value, target = M.areas.find(a => a.id === id); if (!target || target.builtin) return;
      const ok = await H().confirmDialog({ title: 'حذف المنطقة المحفوظة؟', subject: { name: target.name, sub: 'منطقة خريطة', color: '#d4ff3f' }, message: 'ستُحذف هذه المنطقة وبيانات خريطتها المحفوظة فقط.', confirmText: 'حذف المنطقة' });
      if (!ok) return;
      try { await areaStore.removeArea(id); await reloadAreaList(); openSetup(); $('#gs-status').textContent = 'حُذفت المنطقة المحددة.'; }
      catch (ex) { status('تعذر حذف المنطقة: ' + (ex.message || 'خطأ في التخزين'), true); }
    });
    const updateNetwork = () => { const node = g('#gs-network'); if (node) node.textContent = navigator.onLine === false ? 'الجهاز دون اتصال؛ تبقى المناطق المحفوظة متاحة.' : 'الجهاز متصل بالشبكة؛ قد لا تتوفر بعض الخدمات عبر الإنترنت.'; };
    updateNetwork();
    const updateStorage = async () => {
      const node = g('#gs-storage'); if (!node) return;
      if (!M.areaStorageReady) { node.textContent = 'التخزين الدائم غير متاح.'; g('#gs-persist').disabled = true; return; }
      try {
        const api = navigator.storage, estimate = api && api.estimate ? await api.estimate() : null, persisted = api && api.persisted ? await api.persisted() : false;
        const mb = n => (n / 1048576).toFixed(1);
        node.textContent = `${estimate && Number.isFinite(estimate.usage) ? `المستخدم ${mb(estimate.usage)} ميغابايت` : 'حجم التخزين غير متاح'}${estimate && Number.isFinite(estimate.quota) ? ` من ${mb(estimate.quota)} ميغابايت` : ''} · ${persisted ? 'التخزين محمي من المسح التلقائي' : 'الحماية من المسح التلقائي غير مضمونة'}.`;
        g('#gs-persist').disabled = persisted || !(api && api.persist);
      } catch (_) { node.textContent = 'تعذر تقدير مساحة التخزين.'; g('#gs-persist').disabled = true; }
    };
    updateStorage();
    g('#gs-persist').addEventListener('click', async () => { try { await navigator.storage.persist(); } catch (_) { status('تعذر طلب حماية التخزين.', true); } await updateStorage(); });
    g('#gs-backup-export').addEventListener('click', async () => {
      try {
        const backup = await areaStore.backup(), blob = new Blob([JSON.stringify(backup)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
        if (blob.size > 64 * 1024 * 1024) { URL.revokeObjectURL(url); throw new Error('النسخة أكبر من 64 ميغابايت؛ صدّر المناطق منفردة.'); }
        a.href = url; a.download = 'map-areas-backup.json'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (ex) { status('تعذر تصدير المناطق: ' + (ex.message || 'خطأ في التخزين'), true); }
    });
    let backupDraft = null, backupGeneration = 0;
    g('#gs-backup-file').addEventListener('change', async e => {
      const seq = ++backupGeneration, f = e.target.files[0], box = g('#gs-backup-preview'), apply = g('#gs-backup-apply'); backupDraft = null; apply.hidden = true; box.textContent = '';
      if (!f) return;
      if (f.size > 64 * 1024 * 1024) { box.textContent = 'الملف أكبر من 64 ميغابايت.'; return; }
      try {
        const value = JSON.parse(await f.text()); if (seq !== backupGeneration) return;
        const info = areaStore.inspectBackup(value); backupDraft = value;
        box.textContent = `المعاينة: ${info.count} منطقة، بينها ${info.maps} خريطة محفوظة. ستُضاف نسخ جديدة دون استبدال الموجود.`;
        apply.hidden = info.count === 0;
      } catch (ex) { if (seq === backupGeneration) box.textContent = 'تعذر قراءة النسخة: ' + (ex.message || 'ملف غير صالح'); }
    });
    g('#gs-backup-apply').addEventListener('click', async () => {
      if (!backupDraft || manualAreaDownload) return;
      const button = g('#gs-backup-apply'); button.disabled = true;
      try { const count = await areaStore.importBackup(backupDraft); await reloadAreaList(); openSetup(); $('#gs-status').textContent = `أُضيفت ${count} نسخة من المناطق دون استبدال البيانات.`; }
      catch (ex) { g('#gs-backup-preview').textContent = 'تعذر استيراد المناطق: ' + (ex.message || 'خطأ في التخزين'); button.disabled = false; }
    });
    m.onclick = e => { if (e.target.closest('[data-m-close]') && manualAreaDownload) manualAreaDownload.abort(); };
    const read = () => {
      const lat = Number(g('#gs-lat').value), lng = Number(g('#gs-lng').value), side = Number(g('#gs-side').value);
      if (!G.validLatLng(lat, lng) || g('#gs-lat').value === '' || g('#gs-lng').value === '') return null;
      if (!(side >= 4 && side <= G.MAX_AREA_SIDE_KM)) return null;
      const bbox = G.bboxAround(lat, lng, side);
      return { name: g('#gs-name').value.trim() || 'منطقة مخصصة', center: { lat, lng }, sideKm: side, bbox, detail, areaKm2: G.bboxAreaKm2(bbox) };
    };
    const area = () => {
      const v = read();
      g('#gs-area').textContent = v ? `${v.areaKm2} كم²` : '—';
      const est2 = v ? G.estimateBasemapSize(v.bbox, detail) : null;
      g('#gs-est').textContent = est2 ? `${est2.label} · ${est2.parts} ${est2.parts > 1 ? 'أجزاء' : 'جزء واحد'}` : '—';
    };
    ['#gs-lat', '#gs-lng', '#gs-side'].forEach(s => g(s).addEventListener('input', area));
    $$('#gs-detail button', form).forEach(b => b.addEventListener('click', () => {
      detail = b.dataset.v; $$('#gs-detail button', form).forEach(x => x.setAttribute('aria-checked', String(x === b))); area();
    }));
    g('#gs-search').addEventListener('click', async () => {
      const q = g('#gs-q').value.trim(), box = g('#gs-results'); if (!q) return; box.hidden = false; box.innerHTML = '<p class="empty-note">جارٍ البحث…</p>';
      try {
        const list = await searchPlaces(q);
        box.innerHTML = list.length ? list.map((r, i) => `<button type="button" data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.display)}</small></button>`).join('') : '<p class="empty-note">لا توجد نتائج.</p>';
        $$('button', box).forEach(b => b.addEventListener('click', () => { const r = list[Number(b.dataset.i)]; g('#gs-lat').value = r.lat.toFixed(5); g('#gs-lng').value = r.lng.toFixed(5); g('#gs-name').value = r.name; box.hidden = true; area(); }));
      } catch (e) { box.innerHTML = e.code === 'sensitive_query' ? '<p role="alert">لا يُرسل البحث عبر الإنترنت لأنه يتضمن بيانات حساسة محفوظة.</p>' : '<p class="empty-note">تعذر البحث: يلزم اتصال بالإنترنت. أدخل الإحداثيات يدويًا.</p>'; }
    });
    g('#gs-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); g('#gs-search').click(); } });

    // «إعادة التحميل»: re-download the built-in area without leaving the dialog.
    g('#gs-reload').addEventListener('click', async () => {
      const ctrl = beginDownload(); if (!ctrl) return;
      M.builtinArea = builtin;
      try {
        status('جارٍ تنزيل خريطة الشوارع…');
        const raw = await fetchBasemap(builtin.bbox, builtin.detail || 'medium', t => status(t), ctrl.signal);
        if (ctrl.signal.aborted) throw Object.assign(new Error('تم إلغاء التنزيل.'), { name: 'AbortError' });
        g('#gs-cancel').disabled = true;
        await installBasemap(raw, builtin, { activate: !M.area || M.area.builtin, expectedActiveId: AreaStore.BUILTIN });
        M.vectorHash = '';
        const s2 = G.inflate(raw).stats;
        status(`تم! ${s2.labels} اسمًا · ${s2.roads} طريقًا — تعمل الخريطة دون اتصال.`);
        if (!M.base && M.area && !M.area.builtin) setVectorStatus('missing-area', 'لم تُنزَّل خريطة هذه المنطقة بعد.'); else setVectorStatus('ready', '');
      } catch (ex) {
        status(ex && ex.name === 'AbortError' ? 'تم إلغاء التنزيل. بقيت الخريطة السابقة كما هي.' : 'تعذر تنزيل الخريطة (' + ((ex && ex.message) || 'خطأ') + '). تأكد من الاتصال، أو استورد ملف خريطة.', true);
      } finally { g('#gs-cancel').disabled = false; endDownload(ctrl); }
    });
    g('#gs-save').addEventListener('click', async () => {
      const v = read();
      if (!v) { status(`أدخل مركزًا صالحًا وطول ضلع بين 4 و ${G.MAX_AREA_SIDE_KM} كم.`, true); return; }
      if (!M.areaStorageReady) { status('التخزين الدائم غير متاح؛ تعذر حفظ منطقة جديدة.', true); return; }
      try {
        v.id = freshAreaId(); v.builtin = false;
        await areaStore.putArea(v, null, true); await reloadAreaList(); await switchWorkingArea(v.id);
        openSetup(); $('#gs-status').textContent = 'حُفظت المنطقة المخصصة. استخدم «تنزيل هذه المنطقة» لجلب بياناتها.';
      } catch (ex) { status('تعذر حفظ المنطقة: ' + (ex.message || 'خطأ في التخزين'), true); }
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const v = read();
      if (!v) { status(`أدخل مركزًا صالحًا وطول ضلع بين 4 و ${G.MAX_AREA_SIDE_KM} كم.`, true); return; }
      v.id = !isBuiltinArea && current && AreaStore.sameBounds(v.bbox, current.bbox) ? current.id : freshAreaId(); v.builtin = false;
      const ctrl = beginDownload(); if (!ctrl) return;
      try {
        const raw = await fetchBasemap(v.bbox, v.detail, t => status(t), ctrl.signal);
        if (ctrl.signal.aborted) throw Object.assign(new Error('تم إلغاء التنزيل.'), { name: 'AbortError' });
        g('#gs-cancel').disabled = true;
        await installBasemap(raw, v);
        const s = M.base.stats;
        status(`تم! حُفظت الخريطة للعمل دون اتصال: ${s.roads} طريق · ${s.water} مسطح مائي · ${s.green} حديقة · ${s.labels} اسم مكان.`);
        setVectorStatus('ready', '');
        setTimeout(() => m.classList.remove('open'), 900);
      } catch (ex) {
        M.positioned = false; resize(); schedule(); updateHud();
        status(ex && ex.name === 'AbortError' ? 'تم إلغاء التنزيل. بقيت الخريطة السابقة كما هي.' : 'تعذر تنزيل الخريطة (' + ((ex && ex.message) || 'خطأ') + '). تأكد من الاتصال بالإنترنت وحاول لاحقًا، أو اختر «أساسي» لتقليل الحجم، أو استورد ملف خريطة.', true);
      } finally { g('#gs-cancel').disabled = false; endDownload(ctrl); }
    };
    g('#gs-export').addEventListener('click', async () => {
      const raw = await kvGet('basemap'); if (!raw) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...raw, area: M.area })], { type: 'application/json' }));
      const l = document.createElement('a'); l.href = url; l.download = `map-area${M.area && M.area.name ? '-' + M.area.name.replace(/[^\w؀-ۿ-]+/g, '_') : ''}.json`; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    g('#gs-import').addEventListener('click', () => g('#gs-file').click());
    g('#gs-file').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const raw = JSON.parse(await f.text()); G.validateBasemap(raw);
        const b = raw.bbox, center = { lat: (b.s + b.n) / 2, lng: (b.w + b.e) / 2 };
        const ar = raw.area && raw.area.center ? raw.area : { name: 'منطقة مستوردة', center, sideKm: Math.round((b.n - b.s) * 110.574), bbox: b, detail: raw.detail || 'medium', areaKm2: G.bboxAreaKm2(b) };
        delete raw.area; ar.id = freshAreaId(); ar.builtin = false; await installBasemap(raw, ar); status('تم استيراد ملف الخريطة.'); setTimeout(() => m.classList.remove('open'), 700);
      } catch (ex) { status('تعذر استيراد الملف: ' + (ex.message || 'ملف غير صالح'), true); }
    });
    area();
    m.classList.add('open');
    setTimeout(() => { const close = $('header [data-m-close]', m); if (close) close.focus(); }, 30);
  }

  const DAY_MS = 86400000;
  const dateDay = s => Math.floor(Date.parse(s + 'T00:00:00Z') / DAY_MS);
  const dayString = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
  function updateTimeBounds(all) {
    const range = G.timeRangeOfPins(all, C.dateRange), t = M.time;
    if (!range) { if (t.playing) pauseTimeline(); t.range = null; t.cursor = null; return; }
    const next = { min: dateDay(range.min), max: dateDay(range.max) };
    if (t.cursor === null || !Number.isFinite(t.cursor)) t.cursor = next.max;
    else if (t.range && t.cursor === t.range.max && next.max > t.range.max) t.cursor = next.max;
    else t.cursor = Math.max(next.min, Math.min(next.max, t.cursor));
    t.range = next;
  }
  function setTime(day) {
    const t = M.time; if (!t.range) return;
    const before = new Set(pins().map(p => p.key));
    t.cursor = Math.max(t.range.min, Math.min(t.range.max, Math.round(day)));
    const after = pins();
    if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      const added = after.filter(p => !before.has(p.key));
      for (const p of added) t.pulses.set(p.key, true);
      if (added.length) setTimeout(() => { added.forEach(p => t.pulses.delete(p.key)); schedule(); }, 900);
    }
    if (M.activeEvent && !pinByKey(M.activeEvent)) { M.hideCard = M.activeEvent; }
    renderCard(); updateTimeline(); schedule();
  }
  function pauseTimeline() {
    const t = M.time; t.playing = false; t.last = 0; t.fraction = 0; if (t.raf) cancelAnimationFrame(t.raf); t.raf = 0; updateTimeline();
  }
  function playTimeline() {
    const t = M.time; if (!t.range) return;
    if (t.cursor >= t.range.max) setTime(t.range.min);
    t.playing = true; t.last = 0; t.fraction = 0; updateTimeline();
    const tick = now => {
      if (!t.playing) return;
      if (t.last) {
        t.fraction += Math.min(250, now - t.last) * t.speed / 150;
        const days = Math.floor(t.fraction);
        if (days) { t.fraction -= days; setTime(t.cursor + days); }
        if (t.cursor >= t.range.max) { pauseTimeline(); return; }
      }
      t.last = now; t.raf = requestAnimationFrame(tick);
    };
    t.raf = requestAnimationFrame(tick);
  }
  function updateTimeline() {
    if (!el.timebar) return;
    const t = M.time; el.timebar.hidden = !t.range; el.frame.classList.toggle('has-time', !!t.range);
    if (!t.range) return;
    const date = dayString(t.cursor), text = C.formatDate({ date, datePrecision: 'exact' });
    el.timeSlider.min = t.range.min; el.timeSlider.max = t.range.max; el.timeSlider.value = t.cursor;
    el.timeSlider.setAttribute('aria-valuetext', text); el.timeDate.textContent = text;
    el.timePlay.textContent = t.playing ? 'إيقاف مؤقت' : 'تشغيل';
    el.timePlay.setAttribute('aria-label', t.playing ? 'إيقاف مؤقت' : 'تشغيل الشريط الزمني');
    el.timeSpeed.value = String(t.speed); el.timeMode.value = t.mode; el.timeMonths.value = String(t.months); el.timeMonths.disabled = t.mode !== 'window';
  }
  function bindTimeline() {
    el.timePlay.addEventListener('click', () => M.time.playing ? pauseTimeline() : playTimeline());
    el.timeSpeed.addEventListener('change', () => { M.time.speed = Number(el.timeSpeed.value); });
    el.timeMode.addEventListener('change', () => { M.time.mode = el.timeMode.value; setTime(M.time.cursor); });
    el.timeMonths.addEventListener('change', () => { M.time.months = Number(el.timeMonths.value); setTime(M.time.cursor); });
    el.timeSlider.addEventListener('input', () => { const value = Number(el.timeSlider.value); pauseTimeline(); setTime(value); });
    el.timeSlider.addEventListener('keydown', e => {
      if (e.key !== 'PageUp' && e.key !== 'PageDown' && !(e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) return;
      e.preventDefault(); pauseTimeline();
      const d = new Date(M.time.cursor * DAY_MS), delta = (e.key === 'PageUp' || e.key === 'ArrowRight') ? 1 : -1;
      if (e.key.startsWith('Page')) d.setUTCFullYear(d.getUTCFullYear() + delta); else d.setUTCMonth(d.getUTCMonth() + delta);
      setTime(Math.floor(d.getTime() / DAY_MS));
    });
  }

  // Map-only filters, separate from the graph toolbar's matchIds.
  function renderFilters() {
    const f = M.filters, kinds = [['entity', 'الكيانات'], ['shared-event', 'الأحداث المشتركة'], ['personal-event', 'الأحداث الشخصية'], ['routes', 'المسارات'], ...((hostState().data.zones || []).length ? [['zones', 'المناطق']] : [])];
    const schemaEntries = Object.entries(H().TYPE_AR || {}).sort((a, b) => a[1].localeCompare(b[1], 'ar'));
    const currentTypes = new Set(C.EVENT_TYPES.map(t => t.id));
    for (const p of allPins()) if (p.kind !== 'entity') currentTypes.add(String((p.event && p.event.type) || p.node.eventType || 'other'));
    const chip = (group, id, label, selected, color) => `<button type="button" class="geo-filter-chip" data-filter-group="${group}" data-value="${esc(id)}" aria-pressed="${selected}"${color ? ` style="--c:${esc(color)}"` : ''}>${esc(label)}</button>`;
    el.filters.innerHTML = `<p class="geo-compact-notice">أغلق هذه القائمة للعودة إلى أداة الرسم والشريط الزمني.</p><div class="geo-filter-head"><strong>تصفية المواقع</strong><button type="button" class="chip-btn" data-filter-reset>إعادة ضبط</button></div>
      <fieldset><legend>نوع الموقع</legend>${kinds.map(([k, label]) => `<label class="switch-field"><span>${label}</span><input type="checkbox" data-filter-kind="${k}" ${f.kinds[k] ? 'checked' : ''}><i></i></label>`).join('')}</fieldset>
      <fieldset><legend>نوع الحدث</legend><div class="geo-filter-chips">${chip('eventTypes', '', 'الكل', !f.eventTypes.length)}${[...currentTypes].map(id => { const t = C.typeInfo(id); return chip('eventTypes', id, t.label, f.eventTypes.includes(id), t.color); }).join('')}</div></fieldset>
      <fieldset><legend>نوع الكيان</legend><div class="geo-filter-chips">${chip('entityTypes', '', 'الكل', !f.entityTypes.length)}${schemaEntries.map(([id, label]) => chip('entityTypes', id, label, f.entityTypes.includes(id), H().schemaColor(id))).join('')}</div></fieldset>
      <fieldset><legend>الفترة الزمنية</legend><div class="geo-filter-dates"><label>من <input type="date" data-filter-date="from" value="${esc(f.from)}"></label><label>إلى <input type="date" data-filter-date="to" value="${esc(f.to)}"></label></div></fieldset>`;
    updateFilterBadge();
  }
  function updateFilterBadge() {
    if (!el.filterBadge) return;
    const n = filterCount(M.filters); el.filterBadge.hidden = !n; el.filterBadge.textContent = String(n);
    el.filterBtn.setAttribute('aria-label', n ? `تصفية، ${n} مرشحات فعّالة` : 'تصفية');
  }
  function filtersChanged() {
    lsSet('relationship-map-geo-filters', M.filters); updateFilterBadge();
    if (M.activeEvent && !pinByKey(M.activeEvent)) { M.activeEvent = null; M.hideCard = M.selected; }
    renderCard(); schedule();
  }
  function bindFilters() {
    updateFilterBadge();
    el.filters.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.filterKind) M.filters.kinds[t.dataset.filterKind] = t.checked;
      else if (t.dataset.filterDate) M.filters[t.dataset.filterDate] = t.value;
      else return;
      filtersChanged();
    });
    el.filters.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.hasAttribute('data-filter-reset')) M.filters = defaultFilters();
      else if (t.dataset.filterGroup) {
        const key = t.dataset.filterGroup, value = t.dataset.value, arr = M.filters[key];
        M.filters[key] = !value ? [] : arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value];
      } else return;
      filtersChanged(); renderFilters();
    });
  }

  function focusSearchPin(item) {
    const h = hostState();
    // Search spans all data. If another filter hides the selected result, reset
    // it explicitly and tell the user rather than navigating to an invisible pin.
    if ((String(h.search || '').trim() || h.schema !== 'all') && !h.matchIds.has(String(item.node.id))) {
      const q = $('#search'), schema = $('#schema-filter');
      q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
      schema.value = 'all'; schema.dispatchEvent(new Event('change', { bubbles: true }));
      H().setStatus('أُزيلت تصفية الشبكة لإظهار النتيجة');
    }
    if (!G.filterMapPins([item], M.filters, C.dateRange).length) {
      M.filters = defaultFilters(); lsSet('relationship-map-geo-filters', M.filters); updateFilterBadge();
      H().setStatus('أُعيد ضبط تصفية الخريطة لإظهار النتيجة');
    }
    if (item.kind !== 'entity' && M.time.range) {
      const ev = item.kind === 'personal-event' ? item.event : item.node;
      const r = C.dateRange({ date: ev.date, datePrecision: ev.datePrecision || (ev.date ? 'exact' : 'unknown') });
      if (r && !G.eventVisibleAtDate(ev, dayString(M.time.cursor), M.time.mode, M.time.months, C.dateRange)) setTime(dateDay(r[0]));
    }
    H().selectNode(String(item.node.id)); M.activeZone = null; M.activeEvent = item.kind === 'entity' ? null : item.key; M.hideCard = null; M.photoIdx = 0;
    flyTo(item.geo.lat, item.geo.lng, Math.max(M.z, 15)); sync(true);
  }
  function bindMapSearch() {
    let local = [], online = [];
    const show = (visible) => { el.mapResults.hidden = !visible; el.mapSearch.setAttribute('aria-expanded', String(visible)); };
    const render = () => {
      const q = el.mapSearch.value.trim(); online = [];
      if (!q) { local = []; show(false); return; }
      local = G.searchMapPins(G.collectMapPins(hostState().nodes), q, C.norm);
      el.mapResults.innerHTML = local.length ? local.map((item, i) => `<button type="button" role="option" data-map-result="${i}"><i style="background:${esc(pinColor(item))}"></i><span><b>${esc(pinTitle(item))}</b><small>${esc(item.geo.place || item.geo.address || (item.kind === 'entity' ? typeLabelOf(item.node) : 'حدث'))}</small></span></button>`).join('') : '<p>لا توجد نتائج في البيانات المحلية.</p>';
      show(true);
    };
    el.mapSearch.addEventListener('input', render);
    el.mapSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !el.mapResults.hidden) { show(false); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (local[0]) { focusSearchPin(local[0]); show(false); } }
      else if (e.key === 'ArrowDown' && !el.mapResults.hidden) { e.preventDefault(); $('button', el.mapResults)?.focus(); }
    });
    el.searchOnline.addEventListener('click', async () => {
      const q = el.mapSearch.value.trim(); if (!q) { el.mapSearch.focus(); return; }
      local = []; online = []; show(true); el.mapResults.innerHTML = '<p>جارٍ البحث على الإنترنت…</p>';
      try {
        online = await searchPlaces(q);
        el.mapResults.innerHTML = online.length ? online.map((r, i) => `<div class="geo-online-result"><button type="button" data-online-result="${i}"><b>${esc(r.name)}</b><small>${esc(r.display)}</small></button><button type="button" class="chip-btn" data-online-add="${i}">إضافة موقع هنا</button></div>`).join('') : '<p>لا توجد نتائج على الإنترنت.</p>';
      } catch (e) { el.mapResults.innerHTML = e.code === 'sensitive_query' ? '<p role="alert">لا يُرسل البحث عبر الإنترنت لأنه يتضمن بيانات حساسة محفوظة.</p>' : '<p role="alert">تعذر البحث على الإنترنت. تحقق من الاتصال أو استخدم البحث المحلي.</p>'; }
    });
    el.mapResults.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mapResult !== undefined && local[Number(b.dataset.mapResult)]) focusSearchPin(local[Number(b.dataset.mapResult)]);
      else if (b.dataset.onlineResult !== undefined && online[Number(b.dataset.onlineResult)]) { const r = online[Number(b.dataset.onlineResult)]; flyTo(r.lat, r.lng, Math.max(M.z, 15)); }
      else if (b.dataset.onlineAdd !== undefined && online[Number(b.dataset.onlineAdd)]) { const r = online[Number(b.dataset.onlineAdd)]; openLocEditor({ at: r, draft: { lat: r.lat, lng: r.lng, place: r.name, address: r.display, note: '', photos: [] } }); }
      else return;
      show(false);
    });
  }

  // ---- construction ----------------------------------------------------------------------------------
  function build() {
    const mapFrame = $('#map-frame'); if (!mapFrame || el.frame) return;
    const ws = mapFrame.closest('.workspace'); ws.id = 'workspace'; ws.dataset.view = M.view;
    const views = document.createElement('div'); views.className = 'views'; views.id = 'views'; views.dataset.view = M.view; mapFrame.before(views); views.append(mapFrame);
    const frame = document.createElement('div'); frame.className = 'geo-frame'; frame.id = 'geo-frame';
    frame.innerHTML = `
      <canvas id="geo-canvas" tabindex="0" role="application" aria-label="الخريطة الجغرافية؛ الأسهم للتحريك، مسافة لإضافة نقطة في منتصف الخريطة، وEnter لإنهاء المضلع"></canvas>
      <div class="geo-pins" id="geo-pins"></div>
      <div class="geo-timebar" id="geo-timebar" aria-label="الشريط الزمني" hidden>
        <button type="button" id="geo-time-play" class="chip-btn">تشغيل</button>
        <label>السرعة <select id="geo-time-speed" aria-label="سرعة التشغيل"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
        <input type="range" id="geo-time-slider" step="1" aria-label="التاريخ الحالي">
        <output id="geo-time-date" for="geo-time-slider"></output>
        <label>العرض <select id="geo-time-mode" aria-label="نطاق عرض الأحداث"><option value="cumulative">تراكمي</option><option value="window">نافذة</option></select></label>
        <label>الأشهر <select id="geo-time-months" aria-label="طول النافذة بالأشهر"><option value="1">1</option><option value="3">3</option><option value="6">6</option><option value="12">12</option><option value="24">24</option><option value="60">60</option></select></label>
      </div>
      <div class="geo-hud">
        <span class="geo-hud-title"><i class="live-dot" aria-hidden="true"></i> الخريطة الجغرافية</span>
        ${R ? R.switcherHtml() : ''}
        <span class="geo-area-pill" id="geo-area-pill" hidden><span id="geo-area-txt"></span><button type="button" class="chip-btn" data-g="area" title="العودة إلى المنطقة" aria-label="العودة إلى المنطقة">العودة إلى المنطقة</button></span>
        <span id="geo-offline-status" role="status" hidden>دون اتصال بالإنترنت</span>
        <span id="geo-count" aria-live="polite"></span>
        <span id="geo-journey-total" aria-live="polite"></span>
        <span id="geo-coords" dir="ltr"></span>
      <div class="geo-searchbox" id="geo-map-searchbox">
        <div class="geo-map-search-row">${ICON.search}<input id="geo-map-search" type="search" placeholder="ابحث في مواقع الخريطة…" aria-label="البحث في مواقع الخريطة" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="geo-map-results"><button type="button" class="chip-btn" id="geo-search-online" title="يُرسل نص البحث إلى خدمة خارجية؛ لا تُدخل بيانات حساسة">ابحث على الإنترنت</button></div>
        <div id="geo-map-results" class="geo-map-results" role="listbox" hidden></div>
      </div>
      </div>
      <div class="map-controls geo-controls" role="toolbar" aria-label="أدوات الخريطة الجغرافية">
        <button type="button" data-g="in" title="تكبير" aria-label="تكبير">${ICON.plus}</button>
        <button type="button" data-g="out" title="تصغير" aria-label="تصغير">${ICON.minus}</button>
        <button type="button" data-g="pins" title="عرض كل المواقع" aria-label="عرض كل المواقع">${ICON.fit}</button>
        <button type="button" data-g="area" title="العودة إلى المنطقة" aria-label="العودة إلى المنطقة">${ICON.area}</button>
        <button type="button" data-g="add" class="accent" title="إضافة موقع جديد (أو انقر بزر الفأرة الأيمن على الخريطة)" aria-label="إضافة موقع جديد">${ICON.pin}</button>
        <button type="button" data-g="measure" title="قياس المسافة والمساحة" aria-label="قياس المسافة والمساحة" aria-pressed="false">${ICON.ruler}</button>
        <button type="button" data-g="zone" title="رسم منطقة" aria-label="رسم منطقة" aria-expanded="false">${ICON.zone}</button>
        <button type="button" data-g="filters" id="geo-filter-btn" title="تصفية" aria-label="تصفية" aria-expanded="false">${ICON.filter}<span class="geo-filter-badge" id="geo-filter-badge" hidden></span></button>
        <button type="button" data-g="layers" title="الطبقات" aria-label="الطبقات" aria-expanded="false">${ICON.layers}</button>
        <button type="button" data-g="setup" title="منطقة الخريطة والتنزيل دون اتصال" aria-label="منطقة الخريطة">${ICON.gear}</button>
      </div>
      <div class="geo-zone-menu" id="geo-zone-menu" hidden><strong>رسم منطقة</strong>
        <button type="button" class="secondary-btn" data-zone-shape="polygon">مضلع</button>
        <button type="button" class="secondary-btn" data-zone-shape="circle">دائرة</button>
        <button type="button" class="secondary-btn" data-zone-shape="rectangle">مستطيل</button>
        <button type="button" class="secondary-btn" data-zone-io>استيراد / تصدير المواقع</button>
      </div>
      <div class="geo-filters" id="geo-filters" hidden></div>
      <div class="geo-layers" id="geo-layers" hidden>
        <p class="geo-compact-notice">أغلق هذه القائمة للعودة إلى أداة الرسم والشريط الزمني.</p>
        ${R ? R.layersSectionHtml() : ''}
        ${[['roads', 'الطرق'], ['water', 'المياه'], ['green', 'الحدائق والغابات'], ['labels', 'أسماء الأماكن'], ['area', 'حدود المنطقة'], ['dimOutside', 'تعتيم خارج المنطقة'], ['pins', 'المواقع والأحداث'], ['journey', 'مسار الكيان'], ['zones', 'المناطق']].map(([k, l]) => `<label class="switch-field"><span><strong>${l}</strong></span><input type="checkbox" data-layer="${k}"><i></i></label>`).join('')}
        <div class="geo-layer-group" id="geo-label-settings">
          <div class="geo-layer-heading">أسماء الأماكن</div>
          <div class="geo-lang-row">
            <span>لغة الأسماء</span>
            <div class="ev-seg geo-lang-seg" id="geo-label-lang" role="radiogroup" aria-label="لغة الأسماء">
              ${[['ar', 'العربية'], ['en', 'English'], ['both', 'كلاهما']].map(([v, l]) => `<button type="button" role="radio" data-lang="${v}" aria-checked="${M.labelLang === v}">${l}</button>`).join('')}
            </div>
          </div>
          ${LABEL_TOGGLES.map(t => `<label class="switch-field"><span><strong>${t.label}</strong>${t.hint ? ` <small>${t.hint}</small>` : ''}</span><input type="checkbox" data-label-toggle="${t.k}"><i></i></label>`).join('')}
          <label class="switch-field" id="geo-hybrid-hide-wrap" hidden><span><strong>إخفاء ما تعرضه الخريطة المحمّلة</strong></span><input type="checkbox" id="geo-hybrid-hide"><i></i></label>
        </div>
      </div>
      <div class="geo-banner" id="geo-banner" hidden></div>
      <div class="geo-outside-hint" id="geo-outside-hint" hidden><span id="geo-outside-txt">خارج حدود المنطقة</span><button type="button" class="chip-btn" data-g="area" title="العودة إلى المنطقة" aria-label="العودة إلى المنطقة">العودة إلى المنطقة</button></div>
      <div class="geo-card" id="geo-card" hidden></div>
      <div class="geo-scale" aria-hidden="true"><i id="geo-scale-bar"></i><span id="geo-scale-txt"></span></div>
      <div class="geo-attrib" id="geo-attrib">بيانات الخريطة © مساهمو OpenStreetMap</div>
      <div class="geo-zoomnote" id="geo-zoomnote" hidden><span data-zoomnote-text>لم تُنزَّل بيانات خريطة الشوارع بعد</span> <button type="button" class="chip-btn" data-g="setup" data-geo-open-setup title="منطقة الخريطة">⚙</button></div>
      <div class="geo-vecnote" id="geo-vecnote" hidden data-state="idle"><span class="geo-vecnote-dot" aria-hidden="true"></span><span data-vec-text hidden></span><button type="button" class="chip-btn" data-vec-update id="geo-vec-update" hidden>تحديث الخريطة لعرض المزيد من الأسماء</button></div>
      <div class="geo-empty" id="geo-empty" hidden><div><span class="geo-empty-ico">${ICON.map}</span><h3>الخريطة الجغرافية</h3><p>حدّد منطقة العمل (مثلًا 20×20 كم) ونزّل بياناتها مرة واحدة لتعمل دون اتصال، ثم أضف مواقع الكيانات والأحداث وصورها.</p><div class="geo-empty-actions"><button type="button" class="primary-btn" data-g="setup">تحديد منطقة الخريطة</button><button type="button" class="secondary-btn" data-g="add">إضافة موقع</button></div></div></div>`;
    views.append(frame);
    el = {
      views, frame, canvas: $('#geo-canvas'), pins: $('#geo-pins'), count: $('#geo-count'), coords: $('#geo-coords'), banner: $('#geo-banner'), card: $('#geo-card'),
      zoneMenu: $('#geo-zone-menu'), mapSearch: $('#geo-map-search'), mapResults: $('#geo-map-results'), searchOnline: $('#geo-search-online'),
      timebar: $('#geo-timebar'), timePlay: $('#geo-time-play'), timeSpeed: $('#geo-time-speed'), timeSlider: $('#geo-time-slider'), timeDate: $('#geo-time-date'), timeMode: $('#geo-time-mode'), timeMonths: $('#geo-time-months'),
      filters: $('#geo-filters'), filterBtn: $('#geo-filter-btn'), filterBadge: $('#geo-filter-badge'), journeyTotal: $('#geo-journey-total'), scaleBar: $('#geo-scale-bar'), scaleTxt: $('#geo-scale-txt'), attrib: $('#geo-attrib'), zoomNote: $('#geo-zoomnote'), empty: $('#geo-empty'), layers: $('#geo-layers'), measureBtn: $('[data-g="measure"]', frame),
      areaPill: $('#geo-area-pill'), areaText: $('#geo-area-txt'), outsideHint: $('#geo-outside-hint'), outsideTxt: $('#geo-outside-txt'),
      vectorNote: $('#geo-vecnote'), vectorUpdateBtn: $('#geo-vec-update'), zoomNoteText: $('[data-zoomnote-text]', frame),
    };
    el.ctx = el.canvas.getContext('2d');
    if (R) {
      raster = R.createController({ G, M, el, schedule, fitArea, openSetup, lsGet, lsSet });
      raster.wireControls();
    }
    // view switch in the toolbar
    const sw = document.createElement('div'); sw.id = 'view-switch'; sw.className = 'view-switch'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'طريقة العرض');
    sw.innerHTML = [['graph', 'الشبكة', ICON.graph], ['split', 'مقسّم', ICON.split], ['map', 'الخريطة', ICON.map]].map(([v, l, ic]) => `<button type="button" data-view="${v}" aria-pressed="false" title="${l}${v === 'map' ? ' (M)' : ''}">${ic}<span>${l}</span></button>`).join('');
    const anchor = $('#add-edge-btn'); anchor.after(sw);
    sw.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
    const updateOnlineStatus = () => { const offline = navigator.onLine === false, badge = $('#geo-offline-status', frame), status = $('#gs-network'); if (badge) badge.hidden = !offline; if (status) status.textContent = offline ? 'الجهاز دون اتصال؛ تبقى المناطق المحفوظة متاحة.' : 'الجهاز متصل بالشبكة؛ قد لا تتوفر بعض الخدمات عبر الإنترنت.'; };
    window.addEventListener('online', updateOnlineStatus); window.addEventListener('offline', updateOnlineStatus); updateOnlineStatus();
    // controls
    frame.addEventListener('click', e => {
      const b = e.target.closest('[data-g]'); if (!b) return;
      const act = b.dataset.g, cx = M.w / 2, cy = M.h / 2;
      if (act === 'in') zoomAt(cx, cy, M.z + 1); else if (act === 'out') zoomAt(cx, cy, M.z - 1);
      else if (act === 'pins') fitPins(); else if (act === 'area') fitArea();
      else if (act === 'add') startPick(pt => { if (pt) openLocEditor({ at: pt }); });
      else if (act === 'measure') toggleMeasure();
      else if (act === 'zone') { if (M.pick || M.zoneDraw || M.zoneEdit) { toolBusyNotice(); return; } toggleMapPopover('zone'); }
      else if (act === 'filters') toggleMapPopover('filters');
      else if (act === 'layers') toggleMapPopover('layers');
      else if (act === 'setup') openSetup();
    });
    $$('[data-layer]', frame).forEach(cb => { cb.checked = !!M.layers[cb.dataset.layer]; cb.addEventListener('change', () => { M.layers[cb.dataset.layer] = cb.checked; lsSet('relationship-map-geo-layers', M.layers); renderCard(); schedule(); }); });
    // 1B.2 label settings: name language + one toggle per class, both persisted.
    $$('[data-label-toggle]', frame).forEach(cb => {
      const toggle = LABEL_TOGGLES.find(t => t.k === cb.dataset.labelToggle);
      cb.checked = toggleIsOn(toggle);
      cb.addEventListener('change', () => {
        for (const c of toggle.classes) M.labelClasses[c] = cb.checked;
        lsSet('relationship-map-geo-label-classes', M.labelClasses);
        schedule();
      });
    });
    const hideCb = $('#geo-hybrid-hide', frame);
    if (hideCb) {
      hideCb.checked = M.hybridHideRasterClasses;
      hideCb.addEventListener('change', () => { M.hybridHideRasterClasses = hideCb.checked; lsSet('relationship-map-geo-hybrid-hide', hideCb.checked); schedule(); });
    }
    $$('#geo-label-lang [data-lang]', frame).forEach(b => b.addEventListener('click', () => {
      M.labelLang = b.dataset.lang;
      lsSet('relationship-map-geo-label-lang', M.labelLang);
      $$('#geo-label-lang [data-lang]', frame).forEach(x => x.setAttribute('aria-checked', String(x === b)));
      schedule();
    }));
    if (el.vectorUpdateBtn) el.vectorUpdateBtn.addEventListener('click', () => { updateVectorMapFromNotice(); });
    bindZoneMenu();
    bindFilters();
    bindTimeline();
    bindMapSearch();
    bindInteraction();
    el.card.addEventListener('click', e => {
      const id = M.selected, t = e.target.closest('button,img[data-geo-open-photo],img[data-zone-photo]');
      const zone = M.activeZone && zoneById(M.activeZone);
      if (zone && t) handleZoneCardClick(t, zone); else if (id && t) handleCardClick(t, id);
    });
    const frameObserver = new ResizeObserver(() => { resize(); positionToolBanner(); }); frameObserver.observe(frame);
    if (el.timebar) new ResizeObserver(positionToolBanner).observe(el.timebar);
    if (el.banner) new ResizeObserver(positionToolBanner).observe(el.banner);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keydown', e => {
      if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable) || document.querySelector('.ev-modal.open,.confirm-modal,#phase4-modal.open')) return;
      setView(M.view === 'map' ? 'graph' : 'map'); e.preventDefault();
    });
  }
  function handleCardClick(t, id) {
    const d = t.dataset, active = activeEventRecord();
    const node = active ? active.displayNode : nodeById(id), g = active ? active.geo : (node && G.geoOf(node)); if (!g) return;
    const photos = galleryOf(node, g);
    if (d.geoClose !== undefined) { M.hideCard = active ? active.key : String(id); el.card.hidden = true; }
    else if (d.geoPrev !== undefined) { M.photoIdx = (M.photoIdx - 1 + photos.length) % photos.length; renderCard(); }
    else if (d.geoNext !== undefined) { M.photoIdx = (M.photoIdx + 1) % photos.length; renderCard(); }
    else if (d.geoOpenPhoto !== undefined) lightbox(photos, M.photoIdx);
    else if (d.geoCopy !== undefined) { try { navigator.clipboard.writeText(G.formatCoord(g.lat, g.lng)); H().setStatus('تم نسخ الإحداثيات'); } catch (_) { /* clipboard unavailable */ } }
    else if (d.geoGoto) { M.activeEvent = null; M.hideCard = null; H().selectNode(d.geoGoto); const t2 = G.geoOf(nodeById(d.geoGoto)); if (t2) flyTo(t2.lat, t2.lng, Math.max(M.z, 15)); }
    else if (d.geoGraph !== undefined) showInGraph(id);
    else if (d.geoEdit !== undefined) {
      if (active && active.kind === 'personal-event') window.RelationshipEvents.editPersonal(id, active.event.id);
      else if (active) window.RelationshipEvents.edit(id);
      else openLocEditor({ nodeId: id });
    }
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.confirm-modal, #profile-edit.open')) return;
    if (!document.querySelector('.ev-modal.open') && ((!el.zoneMenu.hidden) || (!el.filters.hidden) || (!el.layers.hidden))) { closeMapPopovers(); e.preventDefault(); e.stopPropagation(); return; }
    if ((M.zoneDraw || M.zoneEdit) && !document.querySelector('.ev-modal.open')) { cancelZoneWork(); e.preventDefault(); e.stopPropagation(); return; }
    if (M.time.playing && !document.querySelector('.ev-modal.open')) { pauseTimeline(); e.stopPropagation(); e.preventDefault(); return; }
    const box = $('#geo-lightbox.open'), ed = $('#geo-edit.open') || $('#geo-zone-edit.open') || $('#geo-io.open'), su = $('#geo-setup.open');
    if (box) box.classList.remove('open'); else if (ed) ed.classList.remove('open'); else if (su) { if (manualAreaDownload) manualAreaDownload.abort(); su.classList.remove('open'); }
    else if (M.pick) endPick(null); else if (M.measure) stopMeasure(); else if (el.filters && !el.filters.hidden) { el.filters.hidden = true; el.filterBtn.setAttribute('aria-expanded', 'false'); } else if (!el.layers.hidden) { el.layers.hidden = true; } else return;
    e.stopPropagation(); e.preventDefault();
  }

  // Resolves once /api/tiles/info has been asked; never rejects, so a missing tile pack cannot block startup.
  async function tileInfoReady() {
    if (!raster || typeof raster.ensureInfo !== 'function') return M.tileInfo;
    try { await raster.ensureInfo(); } catch (_) { /* keep going */ }
    return M.tileInfo;
  }

  async function init() {
    if (!window.RelationshipHost) { setTimeout(init, 30); return; }
    build();
    setView(lsGet('relationship-map-view', 'graph'));

    const tileInfo = await tileInfoReady();
    M.builtinArea = builtinAreaFrom(tileInfo);
    try {
      const loaded = await reloadAreaList(); M.areaStorageReady = true;
      M.area = loaded.areas.find(a => a.id === loaded.activeId) || M.builtinArea;
      M.base = loaded.base ? G.inflate(loaded.base) : null;
    } catch (_) {
      M.areaStorageReady = false;
      const legacyArea = await kvGet('area'), raw = await kvGet('basemap');
      M.area = legacyArea && !legacyArea.builtin ? legacyArea : M.builtinArea;
      try { if (raw) { G.validateBasemap(raw); M.base = G.inflate(raw); } } catch (_) { M.base = null; }
    }
    M.vectorHash = (await kvGet('vectormapHash')) || '';
    M.initializing = false;

    if (M.base && M.base.v === 2) {
      M.vectorStatus = 'ready';
      refreshVectorNote();
      resize(); if (M.w) { M.positioned = true; initialPosition(); }
      schedule(); updateHud();
      maybeUpdateVectorMap(); // silent, replaces only after a successful download
    } else if (M.base && M.base.v === 1) {
      M.vectorStatus = 'outdated';
      resize(); if (M.w) { M.positioned = true; initialPosition(); }
      schedule(); updateHud();
      refreshVectorNote(); // shows «تحديث الخريطة لعرض المزيد من الأسماء»
      maybeUpdateVectorMap();
    } else {
      // Fresh install: install the bundled map silently in the background — no dialog, no clicks.
      resize(); if (M.w) { M.positioned = true; initialPosition(); }
      updateHud();
      if (!M.area || M.area.builtin) autoInstallVectorMap();
      else setVectorStatus('missing-area', 'لم تُنزَّل خريطة هذه المنطقة بعد.');
    }
  }

  window.RelationshipMap = {
    dataChanged() {
      if (raster) {
        raster.ensureInfo().then(() => {
          if (el.frame && mapVisible()) {
            if (!M.positioned && M.w) initialPosition();
            sync(); schedule();
          }
        });
      }
      if (el.frame && mapVisible()) { sync(); schedule(); } else sync();
      // Retry an install that was waiting for the session (401 while the login screen was showing).
      if (!M.initializing && !M.base && (!M.area || M.area.builtin) && (M.vectorStatus === 'idle' || M.vectorStatus === 'offline' || M.vectorStatus === 'error')) autoInstallVectorMap();
    },
    sync, locationPanel, wirePanel, showOnMap, openSetup, mountLocationFields,
    pickLocation: startPick,
    // 1B.3 entry points (also used by the E2E tests)
    ensureVectorMap: () => autoInstallVectorMap(),
    updateVectorMap: () => updateVectorMapFromNotice(),
    downloadBuiltinArea: () => fetchBasemap((M.builtinArea || builtinAreaFrom(M.tileInfo)).bbox, 'medium', () => {}),
    // test/automation helpers
    _state: M, _setView: setView, _setBasemap: m => raster && raster.setBasemap(m, true),
    _labelLines: (item, lang) => G.labelLines(item, lang || M.labelLang),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
