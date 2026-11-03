/* Multi-area storage model. Adapter batch() must commit every change atomically. */
(function (root) {
  'use strict';
  const BUILTIN = 'gaza', INDEX = 'areas:index', ACTIVE = 'areas:active';
  const areaKey = id => `area:${id}`, mapKey = id => `basemap:${id}`;
  const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
  const sameBounds = (a, b) => !!a && !!b && ['s', 'w', 'n', 'e'].every(k => typeof a[k] === 'number' && typeof b[k] === 'number' && Math.abs(a[k] - b[k]) < 1e-5);
  function createStore(adapter, geo) {
    if (!adapter || typeof adapter.get !== 'function' || typeof adapter.batch !== 'function') throw new Error('مخزن المناطق غير صالح.');
    const areaValid = area => !!area && typeof area.name === 'string' && area.name.trim() && area.name.length <= 200 && area.center && geo.validLatLng(area.center.lat, area.center.lng) && area.bbox && geo.validLatLng(area.bbox.s, area.bbox.w) && geo.validLatLng(area.bbox.n, area.bbox.e) && area.bbox.s < area.bbox.n && area.bbox.w < area.bbox.e;
    function requireArea(area) {
      if (!areaValid(area) || !safeId(area.id) || (area.builtin && area.id !== BUILTIN) || (!area.builtin && area.id === BUILTIN)) throw new Error('بيانات المنطقة غير صالحة.');
    }
    const validateRaw = raw => { if (raw) geo.validateBasemap(raw); };
    async function index() { const a = await adapter.get(INDEX); return Array.isArray(a) ? a.filter(safeId) : []; }
    async function load(builtin) {
      const built = { ...builtin, id: BUILTIN, builtin: true }; requireArea(built);
      const existing = await adapter.get(INDEX);
      if (!Array.isArray(existing)) {
        const legacyArea = await adapter.get('area'), raw = await adapter.get('basemap');
        const ids = [BUILTIN], writes = [[areaKey(BUILTIN), built]];
        let activeId = BUILTIN;
        if (legacyArea && !legacyArea.builtin && areaValid(legacyArea)) {
          const custom = { ...legacyArea, id: 'legacy', builtin: false }; requireArea(custom);
          ids.push(custom.id); writes.push([areaKey(custom.id), custom]); activeId = custom.id;
        }
        if (raw) {
          try {
            validateRaw(raw);
            if (sameBounds(raw.bbox, built.bbox)) writes.push([mapKey(BUILTIN), raw]);
            else if (activeId !== BUILTIN && sameBounds(raw.bbox, legacyArea.bbox)) writes.push([mapKey(activeId), raw]);
            else {
              const b = raw.bbox, recovered = { id: 'recovered', builtin: false, name: 'خريطة مستعادة', center: { lat: (b.s + b.n) / 2, lng: (b.w + b.e) / 2 }, bbox: b, sideKm: Math.max(4, Math.min(50, Math.round(Math.sqrt(geo.bboxAreaKm2(b))))), detail: raw.detail || 'medium', areaKm2: geo.bboxAreaKm2(b) };
              requireArea(recovered); ids.push(recovered.id); writes.push([areaKey(recovered.id), recovered], [mapKey(recovered.id), raw]);
            }
          } catch (_) { /* leave invalid legacy values untouched for recovery */ }
        }
        writes.push([INDEX, ids], [ACTIVE, activeId]);
        await adapter.batch(writes, []);
      }
      let ids = await index(); if (!ids.includes(BUILTIN)) ids.unshift(BUILTIN);
      const savedBuiltin = await adapter.get(areaKey(BUILTIN));
      if (!savedBuiltin || !savedBuiltin.builtin || !areaValid(savedBuiltin)) await adapter.batch([[areaKey(BUILTIN), built], [INDEX, ids]], []);
      let activeId = await adapter.get(ACTIVE); if (!ids.includes(activeId)) activeId = BUILTIN;
      const areas = [];
      for (const id of ids) { const area = await adapter.get(areaKey(id)); if (area && areaValid(area) && area.id === id && (id === BUILTIN ? area.builtin === true : !area.builtin)) areas.push(area); }
      if (!areas.some(a => a.id === BUILTIN)) areas.unshift(built);
      if (!areas.some(a => a.id === activeId)) activeId = BUILTIN;
      let base = await adapter.get(mapKey(activeId)); if (base) validateRaw(base);
      // Older releases/tests may update the legacy active-map alias directly. Preserve
      // such changes only when its bounds match the current area, never across areas.
      const legacy = await adapter.get('basemap'), activeArea = areas.find(a => a.id === activeId);
      if (Array.isArray(existing) && legacy && sameBounds(legacy.bbox, activeArea.bbox)) {
        try { validateRaw(legacy); if (JSON.stringify(legacy) !== JSON.stringify(base)) { await adapter.batch([[mapKey(activeId), legacy]], []); base = legacy; } } catch (_) { /* keep validated keyed map */ }
      }
      return { areas, activeId, base: base || null };
    }
    async function putArea(area, raw, activate = true, expectedActiveId = null) {
      requireArea(area); validateRaw(raw);
      if (raw && !sameBounds(raw.bbox, area.bbox)) throw new Error('الخريطة لا تطابق حدود المنطقة.');
      if (activate && expectedActiveId && (await adapter.get(ACTIVE)) !== expectedActiveId) activate = false;
      const ids = await index(); if (!ids.includes(BUILTIN)) ids.unshift(BUILTIN); if (!ids.includes(area.id)) ids.push(area.id);
      const writes = [[INDEX, ids], [areaKey(area.id), area]], deletes = [];
      if (raw) writes.push([mapKey(area.id), raw]);
      if (activate) {
        writes.push([ACTIVE, area.id], ['area', area]);
        const effective = raw || await adapter.get(mapKey(area.id));
        if (effective && !sameBounds(effective.bbox, area.bbox)) throw new Error('الخريطة لا تطابق حدود المنطقة.');
        if (effective) writes.push(['basemap', effective]); else deletes.push('basemap');
      }
      await adapter.batch(writes, deletes);
      return { activated: activate };
    }
    async function switchArea(id) {
      if (!safeId(id) || !(await index()).includes(id)) throw new Error('المنطقة غير موجودة.');
      const area = await adapter.get(areaKey(id)), raw = await adapter.get(mapKey(id)); requireArea(area); validateRaw(raw);
      if (raw && !sameBounds(area.bbox, raw.bbox)) throw new Error('الخريطة لا تطابق حدود المنطقة.');
      const writes = [[ACTIVE, id], ['area', area]], deletes = [];
      if (raw) writes.push(['basemap', raw]); else deletes.push('basemap');
      await adapter.batch(writes, deletes); return { area, base: raw || null };
    }
    async function removeArea(id) {
      if (id === BUILTIN) throw new Error('لا يمكن حذف منطقة غزة الافتراضية.');
      if (!safeId(id)) throw new Error('معرّف المنطقة غير صالح.');
      const ids = await index(); if (!ids.includes(id)) throw new Error('المنطقة غير موجودة.');
      const active = await adapter.get(ACTIVE); if (active === id) throw new Error('انتقل إلى منطقة أخرى قبل الحذف.');
      await adapter.batch([[INDEX, ids.filter(x => x !== id)]], [areaKey(id), mapKey(id)]);
    }
    async function backup() {
      const ids = await index(), items = [];
      for (const id of ids) {
        const area = await adapter.get(areaKey(id)), basemap = await adapter.get(mapKey(id));
        requireArea(area); validateRaw(basemap);
        if (basemap && !sameBounds(area.bbox, basemap.bbox)) throw new Error('الخريطة لا تطابق حدود المنطقة.');
        items.push({ area, basemap: basemap || null });
      }
      return { format: 'relationship-map-areas', version: 1, activeId: await adapter.get(ACTIVE), areas: items };
    }
    function inspectBackup(value) {
      if (!value || value.format !== 'relationship-map-areas' || value.version !== 1 || !Array.isArray(value.areas) || value.areas.length > 1000) throw new Error('ملف نسخ المناطق غير صالح.');
      const seen = new Set();
      for (const entry of value.areas) {
        if (!entry || !entry.area || !safeId(entry.area.id) || seen.has(entry.area.id)) throw new Error('معرّف منطقة مكرر أو غير صالح.');
        seen.add(entry.area.id); requireArea(entry.area); validateRaw(entry.basemap);
        if (entry.basemap) { if (!sameBounds(entry.area.bbox, entry.basemap.bbox)) throw new Error('الخريطة لا تطابق حدود المنطقة.'); geo.inflate(entry.basemap); }
      }
      return { count: value.areas.length, maps: value.areas.filter(x => !!x.basemap).length };
    }
    async function importBackup(value) {
      inspectBackup(value);
      const ids = await index(), used = new Set(ids), writes = [];
      for (let i = 0; i < value.areas.length; i++) {
        const src = value.areas[i], a = src.area; let id;
        do { id = `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; } while (used.has(id));
        used.add(id); ids.push(id);
        const area = { id, builtin: false, name: a.builtin ? `${a.name} (نسخة)` : a.name, center: { lat: a.center.lat, lng: a.center.lng }, bbox: { s: a.bbox.s, w: a.bbox.w, n: a.bbox.n, e: a.bbox.e }, sideKm: a.sideKm, detail: a.detail, areaKm2: a.areaKm2 };
        area.name = area.name.slice(0, 200); requireArea(area); writes.push([areaKey(id), area]);
        if (src.basemap) writes.push([mapKey(id), src.basemap]);
      }
      writes.push([INDEX, ids]);
      await adapter.batch(writes, []);
      return value.areas.length;
    }
    // Serialize read-modify-write operations, not just individual IDB transactions.
    let tail = Promise.resolve();
    const serial = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
    return { load: b => serial(() => load(b)), putArea: (a, r, on, expected) => serial(() => putArea(a, r, on, expected)), switchArea: id => serial(() => switchArea(id)), removeArea: id => serial(() => removeArea(id)), backup: () => serial(backup), inspectBackup, importBackup: value => serial(() => importBackup(value)), getMap: id => serial(() => adapter.get(mapKey(id))), sameBounds };
  }
  const api = { createStore, BUILTIN, INDEX, ACTIVE, areaKey, mapKey, sameBounds };
  root.RelationshipGeoAreaStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
