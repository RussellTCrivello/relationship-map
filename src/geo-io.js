/* Offline GeoJSON/KML interchange. No DOM, network, or XML dependencies. */
(function (root) {
  'use strict';
  const LIMIT = 10 * 1024 * 1024, MAX_ITEMS = 10000;
  const bytes = s => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8');
  const text = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const checkSize = s => { if (typeof s !== 'string' || bytes(s) > LIMIT) throw new Error('الملف أكبر من 10 ميغابايت أو غير صالح.'); };
  const xy = c => {
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number' || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw new Error('إحداثيات غير صالحة.');
    return { lat: c[1], lng: c[0] };
  };
  const coord = p => [p.lng, p.lat];
  const photos = v => Array.isArray(v) ? v.slice(0, 12).filter(p => p && typeof p.src === 'string' && /^(https?:\/\/|data:image\/)/i.test(p.src)).map(p => ({ src: p.src, caption: text(p.caption, 1000) })) : [];
  function cleanGeo(p, c, withPhotos) {
    const v = xy(c), src = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    for (const key of ['place', 'address', 'note']) if (typeof src[key] === 'string') v[key] = text(src[key], key === 'note' ? 10000 : 300);
    if (src.to) { try { v.to = xy([src.to.lng, src.to.lat]); if (typeof src.to.place === 'string') v.to.place = text(src.to.place, 200); } catch (_) { /* invalid optional destination omitted */ } }
    if (withPhotos) v.photos = photos(src.photos);
    return v;
  }
  function ringForZone(z) {
    let p;
    if (z.shape === 'circle') {
      // Great-circle destinations, in degrees, preserve metres at all latitudes.
      const lat = z.center.lat * Math.PI / 180, lon = z.center.lng * Math.PI / 180, d = z.radius / 6371008.8;
      p = Array.from({ length: 64 }, (_, i) => { const a = i * Math.PI * 2 / 64, y = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(a)), x = lon + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(y)); return [((x * 180 / Math.PI + 540) % 360) - 180, y * 180 / Math.PI]; });
    } else if (z.shape === 'rectangle') {
      const [a, b] = z.points; p = [coord(a), [b.lng, a.lat], coord(b), [a.lng, b.lat]];
    } else p = z.points.map(coord);
    if (p.length) p.push(p[0].slice());
    return p;
  }
  function toGeoJSON(data, opts = {}) {
    const G = root.RelationshipGeo || (typeof require === 'function' ? require('./geo.js') : null);
    const features = [];
    for (const pin of G.collectMapPins(data.nodes || [])) {
      const p = pin.kind === 'personal-event' ? pin.event : pin.node;
      const g = cleanGeo(pin.geo, [pin.geo.lng, pin.geo.lat], !!opts.photos);
      const rm = { kind: pin.kind, geo: g };
      const P = root.RelationshipProfile || (typeof require === 'function' ? require('./profile.js') : null);
      if (P && pin.kind !== 'personal-event') { const profile = P.exportProfile(p.profile, !!opts.sensitive); if (profile) rm.profile = profile; }
      if (pin.kind !== 'entity') { rm.eventType = text(p.type || p.eventType || 'other', 100); rm.date = text(p.date, 100); rm.datePrecision = text(p.datePrecision, 30); }
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lng, g.lat] }, properties: { name: text(pin.kind === 'personal-event' ? p.title : p.label) || 'موقع', description: text(pin.kind === 'personal-event' ? p.description : p.summary, 10000), relationshipMap: rm } });
    }
    for (const z of data.zones || []) {
      const geometry = { type: 'Polygon', coordinates: [ringForZone(z)] };
      const rm = { kind: 'zone', shape: z.shape, color: z.color, note: text(z.note, 10000) };
      if (z.shape === 'circle') { rm.center = z.center; rm.radius = z.radius; }
      if (z.shape === 'rectangle') rm.points = z.points;
      if (opts.photos) rm.photos = photos(z.photos);
      features.push({ type: 'Feature', geometry, properties: { name: text(z.name) || 'منطقة', description: text(z.note, 10000), relationshipMap: rm } });
    }
    return { type: 'FeatureCollection', features };
  }
  function validZoneMeta(rm) {
    if (rm.shape === 'circle') { xy([rm.center?.lng, rm.center?.lat]); if (typeof rm.radius !== 'number' || !Number.isFinite(rm.radius) || rm.radius <= 0 || rm.radius > 20000000) throw new Error('دائرة غير صالحة.'); return { shape: 'circle', center: { lat: rm.center.lat, lng: rm.center.lng }, radius: rm.radius }; }
    if (rm.shape === 'rectangle' && Array.isArray(rm.points) && rm.points.length === 2) return { shape: 'rectangle', points: rm.points.map(p => xy([p?.lng, p?.lat])) };
    return null;
  }
  function parseGeoJSON(input, opts = {}) {
    if (typeof input === 'string') { checkSize(input); try { input = JSON.parse(input); } catch (_) { throw new Error('تعذر قراءة GeoJSON.'); } }
    if (!input || input.type !== 'FeatureCollection' || !Array.isArray(input.features) || input.features.length > MAX_ITEMS) throw new Error('يلزم ملف GeoJSON من نوع FeatureCollection صالح.');
    const result = { points: [], zones: [], warnings: [] };
    input.features.forEach((f, i) => {
      try {
        if (!f || f.type !== 'Feature' || !f.geometry || (f.properties != null && (typeof f.properties !== 'object' || Array.isArray(f.properties)))) throw new Error('عنصر غير صالح');
        const p = f.properties || {}, r = p.relationshipMap && typeof p.relationshipMap === 'object' && !Array.isArray(p.relationshipMap) ? p.relationshipMap : {};
        const name = text(p.name || p.title) || 'موقع مستورد';
        if (f.geometry.type === 'Point') {
          const geo = cleanGeo(r.geo, f.geometry.coordinates, !!opts.photos);
          const kind = r.kind === 'personal-event' || r.kind === 'shared-event' ? 'event' : 'entity';
          const P = root.RelationshipProfile || (typeof require === 'function' ? require('./profile.js') : null);
          let profile = P && P.normalizeProfile(r.profile);
          if (profile) {
            // Imports create new entity IDs, so original IDs must not accidentally point to unrelated records.
            if (profile.role) delete profile.role.groupId;
            if (profile.family) profile.family.forEach(x => delete x.entityId);
            profile = P.normalizeProfile(profile);
          }
          result.points.push({ name, kind, description: text(p.description, 10000), geo, eventType: text(r.eventType, 100), date: text(r.date, 100), datePrecision: text(r.datePrecision, 30), ...(profile ? { profile } : {}) });
        } else if (f.geometry.type === 'Polygon') {
          const rings = f.geometry.coordinates;
          if (!Array.isArray(rings) || rings.length !== 1 || !Array.isArray(rings[0]) || rings[0].length < 4 || rings[0].length > 10001) throw new Error('المضلعات ذات الفجوات أو النقاط غير الصالحة غير مدعومة');
          const pts = rings[0].map(xy), first = pts[0], last = pts[pts.length - 1];
          if (first.lat !== last.lat || first.lng !== last.lng) throw new Error('المضلع غير مغلق');
          pts.pop();
          const z = { name: text(p.name) || 'منطقة مستوردة', color: /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : '#d4ff3f', note: text(p.description, 10000) };
          const meta = r.kind === 'zone' ? validZoneMeta(r) : null;
          if (meta) {
            const expected = ringForZone(meta), actual = rings[0];
            if (expected.length === actual.length && expected.every((c, n) => Math.abs(c[0] - actual[n][0]) < 1e-5 && Math.abs(c[1] - actual[n][1]) < 1e-5)) Object.assign(z, meta);
            else result.warnings.push(`العنصر ${i + 1}: الشكل الإضافي لا يطابق الهندسة؛ استُخدم المضلع.`);
          }
          if (!z.shape) { z.shape = 'polygon'; z.points = pts; }
          if (opts.photos) z.photos = photos(r.photos);
          result.zones.push(z);
        } else throw new Error('نوع هندسي غير مدعوم');
      } catch (e) { result.warnings.push(`العنصر ${i + 1}: ${e.message}`); }
    });
    return result;
  }
  const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  function toKML(data, opts = {}) {
    const fc = toGeoJSON(data, opts);
    const items = fc.features.map(f => {
      const g = f.geometry, coords = g.type === 'Point' ? g.coordinates.join(',') : g.coordinates[0].map(c => c.join(',')).join(' ');
      const geom = g.type === 'Point' ? `<Point><coordinates>${coords}</coordinates></Point>` : `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
      return `<Placemark><name>${xmlEsc(f.properties.name)}</name><description>${xmlEsc(f.properties.description)}</description><ExtendedData><Data name="relationshipMap"><value>${xmlEsc(JSON.stringify(f.properties.relationshipMap))}</value></Data></ExtendedData>${geom}</Placemark>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${items}</Document></kml>`;
  }
  function decodeXML(s) {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(s)) throw new Error('كيان XML غير مدعوم.');
    return s.replace(/&([^;\s]{1,32});/g, (_, ent) => {
      const basic = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (Object.hasOwn(basic, ent)) return basic[ent];
      if (/^#(?:\d+|x[0-9a-f]+)$/i.test(ent)) { const n = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10); if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n); }
      throw new Error('كيان XML غير مدعوم.');
    });
  }
  function parseXML(s) {
    checkSize(s);
    if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('تعريفات XML الخارجية غير مسموحة.');
    const rootNode = { name: '#document', children: [] }, stack = [rootNode], re = /<!--[\s\S]*?-->|<\?[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^<>\"']|\"[^\"]*\"|'[^']*')*>|[^<]+/g;
    let m, end = 0, count = 0;
    while ((m = re.exec(s))) {
      if (m.index !== end) throw new Error('XML غير صالح.'); end = re.lastIndex;
      const t = m[0], cur = stack[stack.length - 1];
      if (t.startsWith('<!--') || t.startsWith('<?')) continue;
      if (t.startsWith('<![CDATA[')) { cur.text = (cur.text || '') + t.slice(9, -3); continue; }
      if (t.startsWith('</')) { const n = t.slice(2, -1).trim(); if (stack.length < 2 || stack[stack.length - 1].qualified !== n) throw new Error('وسوم XML غير متطابقة.'); stack.pop(); continue; }
      if (t.startsWith('<')) {
        const match = /^<([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:\"[^\"]*\"|'[^']*'))*\s*(\/?)>$/.exec(t); if (!match || ++count > 100000 || stack.length > 100) throw new Error('XML غير صالح أو معقد جدًا.');
        const node = { name: match[1].split(':').pop(), qualified: match[1], attrs: t, children: [], text: '' }; cur.children.push(node); if (!match[2]) stack.push(node); continue;
      }
      cur.text = (cur.text || '') + decodeXML(t);
    }
    if (end !== s.length || stack.length !== 1 || rootNode.children.length !== 1 || rootNode.children[0].name !== 'kml') throw new Error('ملف KML غير صالح.');
    return rootNode.children[0];
  }
  function descendants(node, name) { const out = [], todo = [node]; while (todo.length) { const x = todo.pop(); if (x.name === name) out.push(x); for (let i = x.children.length - 1; i >= 0; i--) todo.push(x.children[i]); } return out; }
  function parseKML(s, opts = {}) {
    const xml = parseXML(s), marks = descendants(xml, 'Placemark'); if (marks.length > MAX_ITEMS) throw new Error('عدد المواقع كبير جدًا.');
    const features = [], warnings = [];
    marks.forEach((m, i) => {
      try {
        const direct = name => m.children.find(n => n.name === name)?.text || '';
        const points = descendants(m, 'Point'), polygons = descendants(m, 'Polygon');
        if (points.length + polygons.length !== 1 || descendants(m, 'LineString').length || descendants(m, 'innerBoundaryIs').length) throw new Error('نوع هندسي أو فجوات غير مدعومة');
        const geom = points[0] || polygons[0], coords = descendants(geom, 'coordinates'); if (coords.length !== 1) throw new Error('إحداثيات غير صالحة');
        const list = coords[0].text.trim().split(/\s+/).map(pair => { const parts = pair.split(','); if (parts.length < 2 || parts[0].trim() === '' || parts[1].trim() === '') throw new Error('إحداثيات غير صالحة'); return [Number(parts[0]), Number(parts[1])]; });
        let rm = {}; const d = descendants(m, 'Data').find(n => /\bname\s*=\s*(["'])relationshipMap\1/.test(n.attrs)); if (d) { const v = descendants(d, 'value')[0]; if (v) { try { rm = JSON.parse(v.text); } catch (_) { throw new Error('بيانات إضافية غير صالحة'); } } }
        features.push({ type: 'Feature', properties: { name: direct('name'), description: direct('description'), relationshipMap: rm }, geometry: points.length ? { type: 'Point', coordinates: list.length === 1 ? list[0] : [] } : { type: 'Polygon', coordinates: [list] } });
      } catch (e) { warnings.push(`العنصر ${i + 1}: ${e.message}`); }
    });
    const result = parseGeoJSON({ type: 'FeatureCollection', features }, opts); result.warnings.unshift(...warnings); return result;
  }
  const api = { LIMIT, toGeoJSON, parseGeoJSON, toKML, parseKML };
  root.RelationshipGeoIO = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
