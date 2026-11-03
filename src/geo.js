(function (root) {
  'use strict';
  // Pure geographic logic for the map view: projection, distances, location records, clustering,
  // pole-of-inaccessibility (polylabel), label priority/collision layout, bbox splitting/merging and the
  // OpenStreetMap -> compact offline basemap (v1 & v2) conversion. No DOM and no network, so it is unit-tested in Node.
  const MAX_LAT = 85.0511287798;
  const MAX_PHOTOS = 12;
  const MAX_AREA_SIDE_KM = 50;

  // Built-in Gaza working area bounds (matches offline_map/gaza_copernicus_osm_z11-z17.mbtiles).
  const GAZA_BOUNDS = Object.freeze({
    s: 31.199587,
    w: 34.208336,
    n: 31.610411,
    e: 34.581528,
  });

  // Minimum zoom level at which each label rank (1..6) appears on the map.
  // Owner-tunable table:
  //   6 = governorate / city / sea
  //   5 = town / district / municipality / bay
  //   4 = village / quarter / suburb / island
  //   3 = neighbourhood / camp / named area (residential, industrial, commercial, etc.)
  //   2 = landmark / campus / hospital / park / market / beach / stadium / airport (and mosques/churches when < 400)
  //   1 = small locality / POI (and mosques/churches when >= 400 in the area)
  const RANK_MIN_ZOOM = Object.freeze({
    6: 9,
    5: 11,
    4: 12.2,
    3: 13.2,
    2: 14.5,
    1: 16,
  });

  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const str = v => (v === undefined || v === null ? '' : String(v)).trim();
  const validLatLng = (lat, lng) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };

  // "40.7128, -74.0060" | "40.7128 -74.0060" | "40.7128N 74.0060W"
  function parseCoords(text) {
    const m = String(text || '').trim().match(/^([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/);
    if (!m) return null;
    let lat = Number(m[1]), lng = Number(m[3]);
    if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
    if (m[4] && m[4].toUpperCase() === 'W') lng = -Math.abs(lng);
    return validLatLng(lat, lng) ? { lat, lng } : null;
  }
  const formatCoord = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  // ---- Web Mercator ---------------------------------------------------------------------------------
  const worldSize = z => 256 * 2 ** z;
  function normXY(lat, lng) {
    const la = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return { x: (lng + 180) / 360, y: 0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI) };
  }
  const project = (lat, lng, z) => { const n = normXY(lat, lng), s = worldSize(z); return { x: n.x * s, y: n.y * s }; };
  function unproject(x, y, z) {
    const s = worldSize(z), nx = x / s, ny = y / s;
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180 / Math.PI, lng: nx * 360 - 180 };
  }
  const metersPerPixel = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;

  // ---- distance / area / box ------------------------------------------------------------------------
  function haversine(a, b) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const pathLength = pts => pts.reduce((s, p, i) => (i ? s + haversine(pts[i - 1], p) : 0), 0);

  // Interpolate along the shorter great-circle arc. Antipodes have many shortest
  // arcs; choose a deterministic perpendicular so the result stays finite.
  function routePoints(from, to, steps = 32) {
    if (!from || !to || !validLatLng(from.lat, from.lng) || !validLatLng(to.lat, to.lng)) return [];
    steps = Math.max(1, Math.min(4096, Math.floor(Number(steps) || 32)));
    const rad = Math.PI / 180, vec = p => {
      const lat = p.lat * rad, lng = p.lng * rad;
      return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
    };
    const a = vec(from), b = vec(to), dot = clamp(a.reduce((v, x, i) => v + x * b[i], 0), -1, 1), angle = Math.acos(dot);
    if (angle < 1e-12) return Array.from({ length: steps + 1 }, () => ({ lat: from.lat, lng: from.lng }));
    const sin = Math.sin(angle);
    let perpendicular;
    if (Math.abs(sin) < 1e-10) {
      const axis = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      perpendicular = [a[1] * axis[2] - a[2] * axis[1], a[2] * axis[0] - a[0] * axis[2], a[0] * axis[1] - a[1] * axis[0]];
      const len = Math.hypot(...perpendicular); perpendicular = perpendicular.map(x => x / len);
    }
    const result = [];
    for (let i = 0; i <= steps; i++) {
      if (i === 0) { result.push({ lat: from.lat, lng: from.lng }); continue; }
      if (i === steps) { result.push({ lat: to.lat, lng: to.lng }); continue; }
      const t = i / steps;
      const v = perpendicular ? a.map((x, j) => x * Math.cos(angle * t) + perpendicular[j] * Math.sin(angle * t))
        : a.map((x, j) => (Math.sin((1 - t) * angle) * x + Math.sin(t * angle) * b[j]) / sin);
      result.push({ lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) / rad, lng: Math.atan2(v[1], v[0]) / rad });
    }
    return result;
  }
  // Initial bearing, clockwise in degrees from north.
  function bearing(from, to) {
    if (!from || !to || !validLatLng(from.lat, from.lng) || !validLatLng(to.lat, to.lng)) return null;
    const rad = Math.PI / 180, a = from.lat * rad, b = to.lat * rad, d = (to.lng - from.lng) * rad;
    const y = Math.sin(d) * Math.cos(b), x = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  function toLatLngPair(p) {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === 'object') return [Number(p.lat), Number(p.lng !== undefined ? p.lng : p.lon)];
    return [NaN, NaN];
  }

  // Ray casting, treating a point on an edge as inside. Coordinates use the
  // longitude nearest the tested point so small polygons crossing 180° work.
  function pointInPolygon(point, polygon) {
    if (!point || !validLatLng(point.lat, point.lng) || !Array.isArray(polygon) || polygon.length < 3) return false;
    const pts = polygon.map(p => Array.isArray(p) ? { lat: p[0], lng: p[1] } : p);
    if (pts.some(p => !p || !validLatLng(p.lat, p.lng))) return false;
    const lngs = [pts[0].lng];
    for (let i = 1; i < pts.length; i++) lngs.push(lngs[i - 1] + (((pts[i].lng - lngs[i - 1] + 540) % 360 + 360) % 360 - 180));
    const mean = lngs.reduce((a, b) => a + b, 0) / lngs.length, pointLng = point.lng + 360 * Math.round((mean - point.lng) / 360);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const ax = lngs[j] - pointLng, ay = pts[j].lat - point.lat, bx = lngs[i] - pointLng, by = pts[i].lat - point.lat;
      const cross = ax * by - ay * bx;
      if (Math.abs(cross) < 1e-10 && ax * bx + ay * by <= 1e-10) return true;
      if ((ay > 0) !== (by > 0) && ax + (bx - ax) * (-ay) / (by - ay) > 0) inside = !inside;
    }
    return inside;
  }

  // Area of a polygon (m²) on a local equirectangular plane; accepts [{lat,lng},…] or [[lat,lng],…].
  function polygonArea(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    const coords = pts.map(toLatLngPair).filter(([la, lg]) => isNum(la) && isNum(lg));
    if (coords.length < 3) return 0;
    const lat0 = coords.reduce((s, p) => s + p[0], 0) / coords.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
    let a = 0;
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i], q = coords[(i + 1) % coords.length];
      a += (p[1] * kx) * (q[0] * ky) - (q[1] * kx) * (p[0] * ky);
    }
    return Math.abs(a) / 2;
  }

  // Pole of inaccessibility ("polylabel"-style) for a polygon ring: finds an interior point that
  // maximises the distance to the polygon edges so labels sit cleanly inside concave shapes.
  function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
    let dx = bx - ax, dy = by - ay;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      if (t > 1) { ax = bx; ay = by; }
      else if (t > 0) { ax += dx * t; ay += dy * t; }
    }
    dx = px - ax; dy = py - ay;
    return dx * dx + dy * dy;
  }

  function signedPointToRingDist(px, py, ring) {
    let inside = false, minDistSq = Infinity;
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const ay = ring[i][0], ax = ring[i][1];
      const by = ring[j][0], bx = ring[j][1];
      if (((ay > py) !== (by > py)) && (px < (bx - ax) * (py - ay) / (by - ay) + ax)) inside = !inside;
      const dSq = pointToSegmentDistSq(px, py, ax, ay, bx, by);
      if (dSq < minDistSq) minDistSq = dSq;
    }
    return (inside ? 1 : -1) * Math.sqrt(minDistSq);
  }

  function ringCentroid(ring) {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const ay = ring[j][0], ax = ring[j][1];
      const by = ring[i][0], bx = ring[i][1];
      const f = ax * by - bx * ay;
      cx += (ax + bx) * f;
      cy += (ay + by) * f;
      area += f * 3;
    }
    if (Math.abs(area) < 1e-14) {
      const s = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      return { y: s[0] / ring.length, x: s[1] / ring.length };
    }
    return { y: cy / area, x: cx / area };
  }

  function polylabel(input, precision = 1e-5) {
    if (!Array.isArray(input) || !input.length) return null;
    // Accept either a single ring ([[lat,lng],…] or [{lat,lng},…]) or an array of rings ([outerRing, …]).
    const rawRing = (Array.isArray(input[0]) && input[0].length && (Array.isArray(input[0][0]) || (typeof input[0][0] === 'object' && input[0][0] !== null)))
      ? input[0]
      : input;
    const ring = rawRing.map(toLatLngPair).filter(([la, lg]) => isNum(la) && isNum(lg));
    if (!ring.length) return null;
    if (ring.length < 3) return { lat: round(ring[0][0], 5), lng: round(ring[0][1], 5), distance: 0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lat, lng] of ring) {
      if (lng < minX) minX = lng;
      if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
    }
    const width = maxX - minX, height = maxY - minY;
    const cellSize = Math.min(width, height);
    if (cellSize === 0) return { lat: round(minY, 5), lng: round(minX, 5), distance: 0 };

    const makeCell = (x, y, h) => {
      const d = signedPointToRingDist(x, y, ring);
      return { x, y, h, d, max: d + h * Math.SQRT2 };
    };

    const queue = [];
    const push = cell => queue.push(cell);
    const popMax = () => {
      let bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].max > queue[bestIdx].max) bestIdx = i;
      }
      const best = queue[bestIdx];
      queue[bestIdx] = queue[queue.length - 1];
      queue.pop();
      return best;
    };

    let h = cellSize / 2;
    for (let x = minX; x < maxX; x += cellSize) {
      for (let y = minY; y < maxY; y += cellSize) {
        push(makeCell(x + h, y + h, h));
      }
    }

    const c = ringCentroid(ring);
    let bestCell = makeCell(c.x, c.y, 0);
    const bboxCell = makeCell(minX + width / 2, minY + height / 2, 0);
    if (bboxCell.d > bestCell.d) bestCell = bboxCell;

    let iterations = 0;
    while (queue.length && iterations < 600) {
      iterations++;
      const cell = popMax();
      if (cell.d > bestCell.d) bestCell = cell;
      if (cell.max - bestCell.d <= precision) continue;
      h = cell.h / 2;
      push(makeCell(cell.x - h, cell.y - h, h));
      push(makeCell(cell.x + h, cell.y - h, h));
      push(makeCell(cell.x - h, cell.y + h, h));
      push(makeCell(cell.x + h, cell.y + h, h));
    }

    return { lat: round(bestCell.y, 5), lng: round(bestCell.x, 5), distance: bestCell.d };
  }

  // Places a sea label inside the area from the coastline: the named sea relation's own centre is often far
  // offshore (e.g. the Levantine Sea), so we take the longest coastline segment inside the bbox and step a few
  // kilometres away from the middle of the area, which is the water side.
  function seaLabelPoint(coastSegs, bbox, offsetKm = 2.5) {
    if (!Array.isArray(coastSegs) || !coastSegs.length || !bbox || !validLatLng(bbox.s, bbox.w) || !validLatLng(bbox.n, bbox.e)) return null;
    let best = null, bestLen = -1;
    for (const seg of coastSegs) {
      if (!Array.isArray(seg) || !seg.length) continue;
      const inside = seg.filter(([la, lg]) => validLatLng(la, lg) && inBbox(bbox, la, lg));
      if (inside.length < 2) continue;
      let len = 0;
      for (let i = 1; i < inside.length; i++) len += haversine({ lat: inside[i - 1][0], lng: inside[i - 1][1] }, { lat: inside[i][0], lng: inside[i][1] });
      if (len > bestLen) { bestLen = len; best = inside[Math.floor(inside.length / 2)]; }
    }
    if (!best) return null;
    const cLat = (bbox.s + bbox.n) / 2, cLng = (bbox.w + bbox.e) / 2;
    const cosLat = Math.cos(cLat * Math.PI / 180) || 1;
    let dLat = best[0] - cLat, dLng = (best[1] - cLng) * cosLat;
    const len = Math.hypot(dLat, dLng);
    if (!len) return null;
    dLat /= len; dLng /= len;
    const lat = best[0] + (dLat * offsetKm) / 110.574;
    const lng = best[1] + (dLng * offsetKm) / (111.32 * cosLat);
    if (!validLatLng(lat, lng) || !inBbox(bbox, lat, lng)) return null;
    return { lat: round(lat, 5), lng: round(lng, 5) };
  }

  function bboxAround(lat, lng, sideKm) {
    const half = sideKm / 2, dLat = half / 110.574, dLng = half / (111.32 * Math.cos(lat * Math.PI / 180));
    return { s: round(lat - dLat, 6), w: round(lng - dLng, 6), n: round(lat + dLat, 6), e: round(lng + dLng, 6) };
  }
  const bboxDimensionsKm = b => {
    const mid = (b.s + b.n) / 2;
    const heightKm = Math.max(0, (b.n - b.s) * 110.574);
    const widthKm = Math.max(0, (b.e - b.w) * 111.32 * Math.cos(mid * Math.PI / 180));
    return { widthKm: round(widthKm, 2), heightKm: round(heightKm, 2), maxSideKm: round(Math.max(widthKm, heightKm), 2) };
  };
  const bboxAreaKm2 = b => { const mid = (b.s + b.n) / 2; return round((b.n - b.s) * 110.574 * (b.e - b.w) * 111.32 * Math.cos(mid * Math.PI / 180), 1); };
  const inBbox = (b, lat, lng) => !!b && lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
  function boundsOf(points) {
    if (!points.length) return null;
    let s = 90, n = -90, w = 180, e = -180;
    for (const p of points) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
    return { s, w, n, e };
  }
  // Zoom level at which `b` fits a w×h pixel view.
  function fitZoom(b, w, h, pad = 40) {
    const a = normXY(b.n, b.w), c = normXY(b.s, b.e);
    const dx = Math.max(1e-9, (c.x - a.x) * 256), dy = Math.max(1e-9, (c.y - a.y) * 256);
    return Math.log2(Math.max(10, Math.min((w - pad) / dx, (h - pad) / dy)));
  }
  function formatDistance(m) { return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} كم`; }
  function formatArea(m2) { return m2 < 1e6 ? `${Math.round(m2).toLocaleString('en-US')} م²` : `${(m2 / 1e6).toFixed(2)} كم²`; }
  function niceDistance(maxMeters) {
    const p = 10 ** Math.floor(Math.log10(Math.max(1, maxMeters)));
    for (const k of [5, 2, 1]) if (k * p <= maxMeters) return k * p;
    return p;
  }

  function builtinGazaArea(bounds = GAZA_BOUNDS, name = 'منطقة غزة') {
    const b = bounds && validLatLng(bounds.s, bounds.w) && validLatLng(bounds.n, bounds.e) ? bounds : GAZA_BOUNDS;
    const center = { lat: round((b.s + b.n) / 2, 6), lng: round((b.w + b.e) / 2, 6) };
    const areaKm2 = bboxAreaKm2(b);
    return {
      name: name || 'منطقة غزة',
      rawName: 'Gaza',
      center,
      sideKm: clamp(Math.round(Math.sqrt(areaKm2)), 4, MAX_AREA_SIDE_KM),
      bbox: { s: b.s, w: b.w, n: b.n, e: b.e },
      detail: 'medium',
      areaKm2,
      builtin: true,
    };
  }

  // ---- location records -----------------------------------------------------------------------------
  // node.geo = { lat, lng, place, address, note, photos: [{ src, caption }] }. It rides along inside the
  // entity's attributes in storage, so no database change is needed.
  function normalizeGeo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lat = Number(raw.lat), lng = Number(raw.lng);
    if (raw.lat === '' || raw.lng === '' || raw.lat === null || raw.lng === null || !validLatLng(lat, lng)) return null;
    const photos = (Array.isArray(raw.photos) ? raw.photos : [])
      .map(p => (typeof p === 'string' ? { src: p, caption: '' } : p))
      .filter(p => p && typeof p === 'object' && str(p.src))
      .map(p => ({ src: str(p.src), caption: str(p.caption) })).slice(0, MAX_PHOTOS);
    const result = { lat: round(lat, 6), lng: round(lng, 6), place: str(raw.place), address: str(raw.address), note: str(raw.note), photos };
    if (raw.to !== undefined && raw.to !== null) {
      const t = raw.to, toLat = Number(t.lat), toLng = Number(t.lng);
      if (typeof t !== 'object' || t.lat === '' || t.lng === '' || t.lat === null || t.lng === null || !validLatLng(toLat, toLng)) return null;
      result.to = { lat: round(toLat, 6), lng: round(toLng, 6), place: str(t.place) };
    }
    return result;
  }
  const geoOf = node => normalizeGeo(node && node.geo);
  function applyGeo(node, raw) {
    const g = normalizeGeo(raw);
    if (!g) throw new Error('إحداثيات الموقع غير صالحة.');
    node.geo = g;
    return g;
  }
  function clearGeo(node) { const had = !!(node && node.geo); if (node) delete node.geo; return had; }
  const geoNodes = nodes => nodes.map(node => ({ node, geo: geoOf(node) })).filter(x => x.geo);
  // Map records keep stable keys even when several events belong to the same owner.
  // The graph's filter applies to the owning node, including events inside that node.
  function collectMapPins(nodes, matchIds) {
    const matches = matchIds && matchIds.size ? matchIds : null;
    const list = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || node.id === undefined || node.id === null) continue;
      const id = String(node.id);
      if (matches && !matches.has(id)) continue;
      const geo = geoOf(node);
      if (geo) list.push({ key: `n:${id}`, kind: node.schema === 'Event' ? 'shared-event' : 'entity', node, geo });
      if (node.schema === 'Event') continue;
      for (const event of Array.isArray(node.events) ? node.events : []) {
        if (!event || event.id === undefined || event.id === null) continue;
        const eventGeo = normalizeGeo(event.geo);
        if (eventGeo) list.push({ key: `e:${id}:${String(event.id)}`, kind: 'personal-event', node, event, geo: eventGeo });
      }
    }
    return list;
  }
  // Filtering is pure; the caller supplies chronology's partial-date range parser.
  function filterMapPins(items, filters = {}, dateRange) {
    const kinds = filters.kinds || {}, types = Array.isArray(filters.eventTypes) ? filters.eventTypes : [], schemas = Array.isArray(filters.entityTypes) ? filters.entityTypes : [];
    return items.filter(p => {
      if (kinds[p.kind] === false) return false;
      if (schemas.length && !schemas.includes(String(p.node.schema || 'Thing'))) return false;
      if (p.kind === 'entity') return true;
      const ev = p.kind === 'personal-event' ? p.event : p.node;
      const type = p.kind === 'personal-event' ? ev.type : ev.eventType;
      if (types.length && !types.includes(String(type || 'other'))) return false;
      if ((filters.from || filters.to) && dateRange) {
        const r = dateRange({ date: ev.date, datePrecision: ev.datePrecision || (ev.date ? 'exact' : 'unknown') });
        if (r && ((filters.from && r[1] < filters.from) || (filters.to && r[0] > filters.to))) return false;
      }
      return true;
    });
  }
  // Cumulative includes an event once its earliest possible day is reached. In
  // window mode a partial date is visible if its range overlaps the window.
  function eventVisibleAtDate(event, cursor, mode, months, dateRange) {
    if (!dateRange || !cursor) return true;
    const r = dateRange({ date: event.date, datePrecision: event.datePrecision || (event.date ? 'exact' : 'unknown') });
    if (!r) return true;
    if (r[0] > cursor) return false;
    if (mode !== 'window') return true;
    const dt = new Date(cursor + 'T00:00:00Z');
    if (!Number.isFinite(dt.getTime())) return true;
    const day = dt.getUTCDate(), count = Math.max(1, Math.min(1200, Number(months) || 12));
    dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() - count);
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, last));
    return r[1] >= dt.toISOString().slice(0, 10);
  }
  function timeRangeOfPins(items, dateRange) {
    const ranges = items.filter(p => p.kind !== 'entity').map(p => {
      const ev = p.kind === 'personal-event' ? p.event : p.node;
      return dateRange({ date: ev.date, datePrecision: ev.datePrecision || (ev.date ? 'exact' : 'unknown') });
    }).filter(Boolean);
    if (ranges.length < 2) return null;
    return { min: ranges.reduce((a, r) => r[0] < a ? r[0] : a, ranges[0][0]), max: ranges.reduce((a, r) => r[1] > a ? r[1] : a, ranges[0][1]), count: ranges.length };
  }
  function searchMapPins(items, query, normalize, limit = 8) {
    const norm = normalize || (s => String(s || '').toLowerCase().trim()), q = norm(query);
    if (!q) return [];
    return items.filter(p => {
      const n = p.node || {}, g = p.geo || {}, ev = p.event || (p.kind === 'shared-event' ? n : {});
      const profile = n.profile && typeof n.profile === 'object' ? n.profile : {};
      return norm([n.label, n.labelEn, n.summary, n.role, n.group, profile.role, profile.group,
        ev.title, ev.label, ev.description, ev.summary, g.place, g.address, g.note].filter(Boolean).join(' ')).includes(q);
    }).slice(0, Math.max(0, Math.min(100, Number(limit) || 8)));
  }
  // Photo to show for a location: the first location photo, else the entity photo.
  const coverOf = (node, g) => (g && g.photos[0] && g.photos[0].src) || (node && node.photo) || '';

  // Groups items (screen positions in px) that are closer than `radius` into clusters.
  function cluster(items, radius) {
    const cells = new Map();
    for (const it of items) {
      const k = Math.floor(it.x / radius) + ':' + Math.floor(it.y / radius);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(it);
    }
    return [...cells.values()].map(list => ({
      ids: list.map(i => i.id), count: list.length,
      x: list.reduce((s, i) => s + i.x, 0) / list.length, y: list.reduce((s, i) => s + i.y, 0) / list.length,
    }));
  }

  // ---- OpenStreetMap -> compact offline basemap (v2) ------------------------------------------------
  const HIGHWAYS = {
    major: ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'],
    secondary: ['secondary', 'tertiary', 'secondary_link', 'tertiary_link'],
    minor: ['residential', 'unclassified', 'living_street', 'pedestrian'],
  };

  // All supported OSM `place` tag values and their rank (1..6) + label class (`k`).
  const PLACE_RANK = Object.freeze({
    city: 6,
    sea: 6,
    town: 5,
    district: 5,
    borough: 5,
    village: 4,
    quarter: 4,
    suburb: 4,
    island: 4,
    bay: 4,
    neighbourhood: 3,
    camp: 3,
    refugee_camp: 3,
    square: 2,
    islet: 2,
    hamlet: 1,
    locality: 1,
    city_block: 1,
    farm: 1,
    isolated_dwelling: 1,
  });

  const PLACE_CLASS = Object.freeze({
    city: 'city',
    town: 'city',
    village: 'city',
    district: 'admin',
    borough: 'hood',
    quarter: 'hood',
    suburb: 'hood',
    neighbourhood: 'hood',
    camp: 'hood',
    refugee_camp: 'hood',
    hamlet: 'hood',
    locality: 'hood',
    city_block: 'hood',
    farm: 'hood',
    isolated_dwelling: 'hood',
    square: 'landmark',
    sea: 'water',
    bay: 'water',
    island: 'water',
    islet: 'water',
  });

  const PLACE_KINDS = Object.keys(PLACE_RANK);

  function overpassQuery(b, opts = {}) {
    const detail = opts.detail === 'basic' ? 'basic' : 'medium';
    const bb = `${b.s},${b.w},${b.n},${b.e}`;
    const hw = HIGHWAYS.major.concat(HIGHWAYS.secondary, detail === 'basic' ? [] : HIGHWAYS.minor).join('|');
    const placeRe = PLACE_KINDS.join('|');
    const landuseNamed = detail === 'basic'
      ? 'forest|cemetery|harbour|recreation_ground|recreation'
      : 'residential|commercial|industrial|retail|military|farmland|recreation_ground|recreation|harbour|cemetery|forest';
    return `[out:json][timeout:${opts.timeout || 120}][maxsize:536870912];(
way["highway"~"^(${hw})$"](${bb});
way["railway"="rail"](${bb});
way["waterway"~"^(river|canal)$"](${bb});
way["natural"~"^(water|coastline|wood)$"](${bb});
way["leisure"~"^(park|garden|nature_reserve|golf_course)$"](${bb});
way["landuse"~"^(forest|grass|recreation_ground|cemetery|reservoir)$"](${bb});
relation["natural"="water"](${bb});
relation["leisure"="park"](${bb});
node["place"~"^(${placeRe})$"](${bb});
);out geom(${bb});
(
relation["boundary"="administrative"]["admin_level"~"^(4|5|6|7|8|9|10)$"](${bb});
);out tags center;
(
nwr["leisure"~"^(park|garden|nature_reserve|stadium|sports_centre|marina)$"]["name"](${bb});
nwr["landuse"~"^(${landuseNamed})$"]["name"](${bb});
nwr["amenity"~"^(university|college|school|hospital|marketplace|place_of_worship|grave_yard|refugee_site)$"]["name"](${bb});
nwr["natural"~"^(beach|bay|sea|wood)$"](${bb});
nwr["aeroway"~"^(aerodrome|airport|helipad)$"]["name"](${bb});
way["place"~"^(${placeRe})$"](${bb});
relation["place"~"^(${placeRe})$"](${bb});
nwr["refugee"="yes"](${bb});
);out center;`;
  }

  // Splits a large bounding box into 1x1, 2x2 or 3x3 sub-boxes so Overpass queries succeed reliably.
  function splitBbox(b, opts = {}) {
    if (!b || !validLatLng(b.s, b.w) || !validLatLng(b.n, b.e)) return [];
    const { maxSideKm } = bboxDimensionsKm(b);
    const areaKm2 = bboxAreaKm2(b);
    let grid = Number(opts.grid) || 0;
    if (!grid) {
      if (maxSideKm <= 22 && areaKm2 <= 480) grid = 1;
      else if (maxSideKm <= 47 && areaKm2 <= 1850) grid = 2;
      else grid = 3;
    }
    grid = clamp(Math.round(grid), 1, 4);
    if (grid === 1) return [{ s: b.s, w: b.w, n: b.n, e: b.e, index: 1, total: 1 }];
    const dLat = (b.n - b.s) / grid;
    const dLng = (b.e - b.w) / grid;
    const total = grid * grid;
    const out = [];
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        out.push({
          s: round(b.s + r * dLat, 6),
          w: round(b.w + c * dLng, 6),
          n: round(r === grid - 1 ? b.n : b.s + (r + 1) * dLat, 6),
          e: round(c === grid - 1 ? b.e : b.w + (c + 1) * dLng, 6),
          index: out.length + 1,
          total,
        });
      }
    }
    return out;
  }

  // Estimates download size before fetching from Overpass.
  function estimateBasemapSize(b, detail = 'medium') {
    if (!b || !validLatLng(b.s, b.w) || !validLatLng(b.n, b.e)) return { bytes: 0, label: '—' };
    const areaKm2 = bboxAreaKm2(b);
    const perKm2 = detail === 'basic' ? 680 : 2200;
    const bytes = Math.max(40 * 1024, Math.round(areaKm2 * perKm2));
    const mb = bytes / (1024 * 1024);
    const label = mb >= 1 ? `~${mb.toFixed(1)} م.ب` : `~${Math.round(bytes / 1024)} ك.ب`;
    return { bytes, label, parts: splitBbox(b).length };
  }

  // Merges multiple Overpass JSON responses, de-duplicating elements by OSM type+id while keeping
  // clipped geometry continuations for linear ways without duplicating their labels.
  function mergeOverpass(responses) {
    const byId = new Map();
    const anonymous = [];
    const extraWayGeoms = [];

    for (const resp of (Array.isArray(responses) ? responses : [])) {
      const elements = (resp && Array.isArray(resp.elements)) ? resp.elements : [];
      for (const el of elements) {
        if (!el || typeof el !== 'object') continue;
        if (el.id === undefined || el.id === null) {
          anonymous.push(el);
          continue;
        }
        const key = `${el.type}:${el.id}`;
        const prev = byId.get(key);
        if (!prev) {
          byId.set(key, { ...el });
          continue;
        }
        // Merge tags & center if missing on prev
        if (el.tags && (!prev.tags || Object.keys(el.tags).length > Object.keys(prev.tags).length)) {
          prev.tags = { ...(prev.tags || {}), ...el.tags };
        }
        if (el.center && !prev.center) prev.center = el.center;
        if (isNum(el.lat) && !isNum(prev.lat)) { prev.lat = el.lat; prev.lon = el.lon; }
        if (Array.isArray(el.members) && (!Array.isArray(prev.members) || el.members.length > prev.members.length)) {
          prev.members = el.members;
        }
        if (Array.isArray(el.geometry) && el.geometry.length) {
          const c2 = geom(el.geometry);
          const c1 = geom(prev.geometry);
          if (!c1.length && c2.length) {
            prev.geometry = el.geometry;
          } else if (el.type === 'way' && c1.length && c2.length) {
            const sameGeom = c1.length === c2.length &&
              c1[0][0] === c2[0][0] && c1[0][1] === c2[0][1] &&
              c1[c1.length - 1][0] === c2[c2.length - 1][0] && c1[c1.length - 1][1] === c2[c2.length - 1][1];
            if (!sameGeom) {
              // Stitch if endpoints touch; otherwise keep continuation segment for road/water drawing without producing a duplicate label.
              const stitched = stitch([c1, c2]);
              if (stitched.length === 1) {
                prev.geometry = stitched[0].map(([lat, lon]) => ({ lat, lon }));
              } else {
                extraWayGeoms.push({ ...el, _noLabel: true });
              }
            }
          }
        }
      }
    }
    return { elements: [...byId.values(), ...extraWayGeoms, ...anonymous] };
  }

  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let max = 0, idx = -1;
      const ax = pts[a][1], ay = pts[a][0], bx = pts[b][1], by = pts[b][0], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][1], py = pts[i][0];
        let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0; t = clamp(t, 0, 1);
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d > max) { max = d; idx = i; }
      }
      if (max > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  // [[lat,lng],…] <-> delta-encoded integers (1e-5° ≈ 1 m): first pair absolute, then deltas.
  function pack(pts) {
    const out = []; let pl = 0, pg = 0;
    for (const [lat, lng] of pts) { const a = Math.round(lat * 1e5), g = Math.round(lng * 1e5); out.push(a - pl, g - pg); pl = a; pg = g; }
    return out;
  }
  function unpack(p) {
    const out = []; let la = 0, lg = 0;
    for (let i = 0; i + 1 < p.length; i += 2) { la += p[i]; lg += p[i + 1]; out.push([la / 1e5, lg / 1e5]); }
    return out;
  }
  const closed = pts => pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  const geom = g => (Array.isArray(g) ? g.filter(p => p && isNum(p.lat) && isNum(p.lon)).map(p => [p.lat, p.lon]) : []);
  // Joins open way segments end to end (multipolygon outer rings are often split over several ways).
  function stitch(segs) {
    const rings = [], open = segs.filter(s => s.length > 1).map(s => s.slice());
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    while (open.length) {
      let cur = open.pop();
      let grew = true;
      while (grew && !closed(cur)) {
        grew = false;
        for (let i = 0; i < open.length; i++) {
          const s = open[i];
          if (same(cur[cur.length - 1], s[0])) cur = cur.concat(s.slice(1));
          else if (same(cur[cur.length - 1], s[s.length - 1])) cur = cur.concat(s.slice(0, -1).reverse());
          else if (same(cur[0], s[s.length - 1])) cur = s.concat(cur.slice(1));
          else if (same(cur[0], s[0])) cur = s.slice(1).reverse().concat(cur);
          else continue;
          open.splice(i, 1); grew = true; break;
        }
      }
      rings.push(cur);
    }
    return rings;
  }

  const ARABIC_RE = /[\u0600-\u06FF]/;
  const LATIN_RE = /[A-Za-z]/;
  const CAMP_RE = /مخيم|\bcamp\b/i;

  // Fallback Arabic translations for known Gaza quarters whose OSM relation lacks name:ar.
  const GAZA_AR_GLOSSARY = Object.freeze({
    'South Remal': 'الرمال الجنوبي',
    'North Remal': 'الرمال الشمالي',
    'Tuffah': 'التفاح',
    'Al Nasser': 'النصر',
  });

  function extractNames(t) {
    if (!t || typeof t !== 'object') return null;
    const rawAr = str(t['name:ar']) || (t.name && GAZA_AR_GLOSSARY[str(t.name)]) || '';
    const rawName = str(t.name);
    const rawEn = str(t['name:en'] || t.int_name);
    const n = rawAr || rawName || rawEn;
    if (!n) return null;
    const na = rawAr || (ARABIC_RE.test(rawName) ? rawName : '');
    const ne = rawEn || (LATIN_RE.test(rawName) && !ARABIC_RE.test(rawName) ? rawName : '');
    const out = { n };
    if (na && na !== n) out.na = na;
    if (ne && ne !== n) out.ne = ne;
    return out;
  }

  function isCampFeature(t, names) {
    if (!t) return false;
    if (t.place === 'camp' || t.place === 'refugee_camp' || t.refugee === 'yes' || t.amenity === 'refugee_site') return true;
    const combined = `${names ? names.n : ''} ${(names && names.na) || ''} ${(names && names.ne) || ''} ${t.name || ''} ${t['name:ar'] || ''} ${t['name:en'] || ''}`;
    return CAMP_RE.test(combined);
  }

  function classifyPlaceNode(t, names) {
    const p = t && t.place;
    if (!p || !PLACE_RANK[p]) return null;
    if (isCampFeature(t, names)) {
      return { k: 'hood', r: 3, t: p };
    }
    return { k: PLACE_CLASS[p] || 'hood', r: PLACE_RANK[p], t: p };
  }

  function classifyAreaFeature(el, t, names, worshipHighDensity) {
    if (!t || !names) return null;
    // 1. Administrative boundary relations (admin_level 4..10)
    if (t.boundary === 'administrative' && !t.highway && !t.waterway) {
      const lvl = Number(t.admin_level);
      if (Number.isFinite(lvl) && lvl >= 4 && lvl <= 10) {
        const r = lvl <= 6 ? 6 : lvl <= 8 ? 5 : 4;
        return { k: 'admin', r };
      }
    }
    // 2. Refugee camps
    if (isCampFeature(t, names)) {
      return { k: 'hood', r: 3 };
    }
    // 3. Place polygons/ways/relations
    if (t.place && PLACE_RANK[t.place]) {
      return { k: PLACE_CLASS[t.place] || 'hood', r: PLACE_RANK[t.place] };
    }
    // 4. Water / sea / bay / beach / harbour
    if (t.natural === 'sea') return { k: 'water', r: 6 };
    if (t.natural === 'bay') return { k: 'water', r: 4 };
    if (t.natural === 'beach' || t.landuse === 'harbour' || t.harbour === 'yes' || t.leisure === 'marina' || t.natural === 'water' || t.landuse === 'reservoir') {
      return { k: 'water', r: 2 };
    }
    // 5. Parks, gardens, nature reserves, forests
    if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve' || t.leisure === 'golf_course' || t.landuse === 'forest' || t.landuse === 'grass' || t.natural === 'wood') {
      return { k: 'green', r: 2 };
    }
    // 6. Named landuse areas (residential, commercial, industrial, retail, military, farmland, recreation)
    if (/^(residential|commercial|industrial|retail|military|farmland|recreation_ground|recreation)$/.test(String(t.landuse || ''))) {
      return { k: 'hood', r: 3 };
    }
    // 7. Landmarks: cemeteries, campuses, hospitals, markets, stadiums, airports, places of worship
    if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return { k: 'landmark', r: 2 };
    if (/^(university|college|school|hospital|marketplace)$/.test(String(t.amenity || '')) || t.healthcare === 'hospital') {
      return { k: 'landmark', r: 2 };
    }
    if (t.leisure === 'stadium' || t.leisure === 'sports_centre') return { k: 'landmark', r: 2 };
    if (/^(aerodrome|airport|helipad)$/.test(String(t.aeroway || ''))) return { k: 'landmark', r: 2 };
    if (t.amenity === 'place_of_worship') {
      return { k: 'landmark', r: worshipHighDensity ? 1 : 2 };
    }
    return null;
  }

  function pointForElement(el, rings) {
    if (rings && rings.length) {
      let bestRing = rings[0], bestArea = polygonArea(rings[0]);
      for (let i = 1; i < rings.length; i++) {
        const a = polygonArea(rings[i]);
        if (a > bestArea) { bestArea = a; bestRing = rings[i]; }
      }
      const p = polylabel(bestRing);
      if (p && validLatLng(p.lat, p.lng)) return { lat: p.lat, lng: p.lng, a: Math.round(bestArea) };
    }
    if (el.center && validLatLng(el.center.lat, el.center.lon)) {
      return { lat: round(el.center.lat, 5), lng: round(el.center.lon, 5), a: 0 };
    }
    if (validLatLng(el.lat, el.lon)) {
      return { lat: round(el.lat, 5), lng: round(el.lon, 5), a: 0 };
    }
    const pts = geom(el.geometry);
    if (pts.length) {
      if (closed(pts)) {
        const p = polylabel(pts);
        const area = Math.round(polygonArea(pts));
        if (p && validLatLng(p.lat, p.lng)) return { lat: p.lat, lng: p.lng, a: area };
      }
      const mid = pts[Math.floor(pts.length / 2)];
      return { lat: round(mid[0], 5), lng: round(mid[1], 5), a: 0 };
    }
    return null;
  }

  function parseOverpass(json, bbox, opts = {}) {
    const eps = opts.tolerance === undefined ? 0.00003 : opts.tolerance;
    const merged = mergeOverpass([json]);
    const elements = merged.elements;

    // Count named places of worship to decide whether they appear at landmark zoom (rank 2) or zoom 16 (rank 1).
    let worshipCount = 0;
    for (const el of elements) {
      const t = el && el.tags;
      if (t && t.amenity === 'place_of_worship' && extractNames(t)) worshipCount++;
    }
    const worshipHighDensity = worshipCount >= 400;

    const bm = {
      v: 2,
      bbox,
      created: new Date().toISOString(),
      source: '© OpenStreetMap contributors',
      detail: opts.detail === 'basic' ? 'basic' : 'medium',
      roads: [],
      rail: [],
      water: [],
      waterLines: [],
      green: [],
      places: [],
      areas: [],
    };

    const add = (list, pts, extra, poly) => {
      let p = simplify(pts, eps);
      if (poly ? p.length < 4 : p.length < 2) return;
      list.push({ ...extra, p: pack(p) });
    };
    const polyKind = t => (t.natural === 'water' || t.landuse === 'reservoir' ? 'water' : (t.leisure || t.landuse || t.natural === 'wood') ? 'green' : null);

    const seenLabelIds = new Set();
    const seenLabelKeys = new Set();
    const seaNames = [];      // named natural=sea features, whose own centre may sit outside the area
    const coastSegs = [];     // coastline segments used to place a sea label inside the area
    const canAddLabel = (el, k, n, lat, lng) => {
      // Drop points that are clearly corrupt or far outside the target bbox when bbox is valid.
      if (bbox && validLatLng(bbox.s, bbox.w) && validLatLng(bbox.n, bbox.e)) {
        const padLat = Math.max(0.15, (bbox.n - bbox.s) * 0.5);
        const padLng = Math.max(0.15, (bbox.e - bbox.w) * 0.5);
        if (lat < bbox.s - padLat || lat > bbox.n + padLat || lng < bbox.w - padLng || lng > bbox.e + padLng) return false;
        if (opts.clipBbox && !inBbox(bbox, lat, lng)) return false;
      }
      if (el._noLabel) return false;
      if (el.id !== undefined && el.id !== null) {
        const idKey = `${el.type}:${el.id}`;
        if (seenLabelIds.has(idKey)) return false;
        seenLabelIds.add(idKey);
      }
      const coordKey = `${k}:${n}:${round(lat, 3)}:${round(lng, 3)}`;
      if (seenLabelKeys.has(coordKey)) return false;
      seenLabelKeys.add(coordKey);
      return true;
    };

    for (const el of elements) {
      const t = el.tags || {};
      const names = extractNames(t);

      if (t.natural === 'sea' && names) seaNames.push(names);
      if (el.type === 'way' && t.natural === 'coastline') {
        const seg = geom(el.geometry);
        if (seg.length > 1) coastSegs.push(seg);
      }

      if (el.type === 'node') {
        if (t.place && names && PLACE_RANK[t.place] && isNum(el.lat) && isNum(el.lon)) {
          const cls = classifyPlaceNode(t, names);
          const lat = round(el.lat, 5), lng = round(el.lon, 5);
          if (cls && canAddLabel(el, cls.k, names.n, lat, lng)) {
            const item = { ...names, t: cls.t, k: cls.k, r: cls.r, lat, lng };
            bm.places.push(item);
          }
          continue;
        }
        if (names && isNum(el.lat) && isNum(el.lon)) {
          const cls = classifyAreaFeature(el, t, names, worshipHighDensity);
          const lat = round(el.lat, 5), lng = round(el.lon, 5);
          if (cls && canAddLabel(el, cls.k, names.n, lat, lng)) {
            bm.areas.push({ ...names, k: cls.k, r: cls.r, lat, lng });
          }
        }
      } else if (el.type === 'way') {
        const pts = geom(el.geometry);
        let drewLinear = false;
        if (pts.length >= 2) {
          if (t.highway) {
            const k = HIGHWAYS.major.includes(t.highway) ? 'major' : HIGHWAYS.secondary.includes(t.highway) ? 'secondary' : HIGHWAYS.minor.includes(t.highway) ? 'minor' : null;
            if (k) add(bm.roads, pts, k === 'minor' ? { k } : { k, n: (names && names.n) || undefined });
            drewLinear = true;
          } else if (t.railway === 'rail') {
            add(bm.rail, pts, {});
            drewLinear = true;
          } else if (t.waterway) {
            add(bm.waterLines, pts, {});
            drewLinear = true;
          } else if (t.natural === 'coastline') {
            add(bm.waterLines, pts, {});
            drewLinear = true;
          } else {
            const pk = polyKind(t);
            if (pk && closed(pts)) add(pk === 'water' ? bm.water : bm.green, pts, {}, true);
          }
        }
        if (!drewLinear && names) {
          const cls = classifyAreaFeature(el, t, names, worshipHighDensity);
          if (cls) {
            const rings = closed(pts) ? [pts] : null;
            const pt = pointForElement(el, rings);
            if (pt && canAddLabel(el, cls.k, names.n, pt.lat, pt.lng)) {
              const areaItem = { ...names, k: cls.k, r: cls.r, lat: pt.lat, lng: pt.lng };
              if (pt.a > 0) areaItem.a = pt.a;
              bm.areas.push(areaItem);
            }
          }
        }
      } else if (el.type === 'relation') {
        const pk = polyKind(t);
        let closedRings = [];
        if (Array.isArray(el.members) && el.members.length) {
          const outers = el.members.filter(m => m.type === 'way' && m.role === 'outer').map(m => geom(m.geometry)).filter(g => g.length > 1);
          if (outers.length) {
            closedRings = stitch(outers).filter(closed);
            if (pk) {
              for (const ring of closedRings) add(pk === 'water' ? bm.water : bm.green, ring, {}, true);
            }
          }
        }
        if (names) {
          const cls = classifyAreaFeature(el, t, names, worshipHighDensity);
          if (cls) {
            const pt = pointForElement(el, closedRings.length ? closedRings : null);
            if (pt && canAddLabel(el, cls.k, names.n, pt.lat, pt.lng)) {
              const areaItem = { ...names, k: cls.k, r: cls.r, lat: pt.lat, lng: pt.lng };
              if (pt.a > 0) areaItem.a = pt.a;
              bm.areas.push(areaItem);
            }
          }
        }
      }
    }

    // A sea whose own label point falls outside the area still deserves a name on the water next to the coast.
    if (seaNames.length && !bm.areas.some(a => a.k === 'water' && a.r >= 5)) {
      const pt = seaLabelPoint(coastSegs, bbox);
      if (pt && canAddLabel({ type: 'sea', id: 'coast' }, 'water', seaNames[0].n, pt.lat, pt.lng)) {
        bm.areas.push({ ...seaNames[0], k: 'water', r: 6, lat: pt.lat, lng: pt.lng });
      }
    }

    bm.places.sort((a, b) => (b.r - a.r) || ((b.a || 0) - (a.a || 0)));
    bm.areas.sort((a, b) => (b.r - a.r) || ((b.a || 0) - (a.a || 0)));
    return bm;
  }

  const basemapStats = bm => {
    const places = Array.isArray(bm.places) ? bm.places.length : 0;
    const areas = Array.isArray(bm.areas) ? bm.areas.length : 0;
    return {
      roads: bm.roads.length,
      rail: bm.rail.length,
      water: bm.water.length + bm.waterLines.length,
      green: bm.green.length,
      places,
      areas,
      labels: places + areas,
      points: [bm.roads, bm.rail, bm.water, bm.waterLines, bm.green].reduce((s, l) => s + l.reduce((q, f) => q + f.p.length / 2, 0), 0),
    };
  };

  function normalizeLabelItem(item, isPlace) {
    const t = item.t || '';
    const k = item.k || (isPlace ? (PLACE_CLASS[t] || 'city') : 'hood');
    // Upgrade legacy v1 place ranks (where city=5, town=4, suburb/village=3, neighbourhood=2, hamlet=1) if v1 item lacks k.
    let r = Number(item.r) || 1;
    if (!item.k && isPlace && PLACE_RANK[t]) r = PLACE_RANK[t];
    r = clamp(Math.round(r), 1, 6);
    const xy = (isNum(item.x) && isNum(item.y)) ? { x: item.x, y: item.y } : normXY(item.lat, item.lng);
    return {
      ...item,
      k,
      r,
      a: Number(item.a) || 0,
      minZoom: isNum(item.minZoom) ? item.minZoom : (RANK_MIN_ZOOM[r] || 16),
      x: xy.x,
      y: xy.y,
    };
  }

  // Prepares a basemap (v1 or v2) for drawing: normalised Mercator coordinates in Float64Arrays (x,y interleaved).
  function inflate(bm) {
    const conv = f => {
      const pts = unpack(f.p), a = new Float64Array(pts.length * 2);
      pts.forEach(([lat, lng], i) => { const n = normXY(lat, lng); a[i * 2] = n.x; a[i * 2 + 1] = n.y; });
      return { ...f, pts: a };
    };
    const places = (bm.places || []).map(p => normalizeLabelItem(p, true));
    const areas = (bm.areas || []).map(a => normalizeLabelItem(a, false));
    const labels = [...places, ...areas].sort((a, b) => (b.r - a.r) || ((b.a || 0) - (a.a || 0)));
    return {
      v: bm.v || 1,
      bbox: bm.bbox,
      created: bm.created,
      source: bm.source,
      detail: bm.detail,
      stats: basemapStats(bm),
      roads: bm.roads.map(conv),
      rail: bm.rail.map(conv),
      water: bm.water.map(conv),
      waterLines: bm.waterLines.map(conv),
      green: bm.green.map(conv),
      places,
      areas,
      labels,
    };
  }

  function validateBasemap(bm) {
    if (!bm || typeof bm !== 'object' || (bm.v !== 1 && bm.v !== 2) || !bm.bbox || !validLatLng(bm.bbox.s, bm.bbox.w) || !validLatLng(bm.bbox.n, bm.bbox.e)) {
      throw new Error('ملف الخريطة غير صالح.');
    }
    for (const k of ['roads', 'rail', 'water', 'waterLines', 'green', 'places']) {
      if (!Array.isArray(bm[k])) throw new Error('ملف الخريطة ناقص: ' + k);
    }
    if (bm.v === 2 && !Array.isArray(bm.areas)) {
      throw new Error('ملف الخريطة ناقص: areas');
    }
    return bm;
  }

  // ---- Label formatting, wrapping, zoom fade & collision layout -------------------------------------
  function wrapLabel(text, maxChars = 18) {
    const s = str(text);
    if (!s) return [];
    if (s.includes('\n')) return s.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2);
    if (s.length <= maxChars || !s.includes(' ')) return [s];
    const words = s.split(/\s+/);
    if (words.length < 2) return [s];
    const mid = s.length / 2;
    let bestSplit = 1, bestDiff = Infinity, acc = 0;
    for (let i = 0; i < words.length - 1; i++) {
      acc += words[i].length + (i ? 1 : 0);
      const diff = Math.abs(acc - mid);
      if (diff < bestDiff) { bestDiff = diff; bestSplit = i + 1; }
    }
    return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')];
  }

  function labelLines(item, lang = 'ar', maxChars = 18) {
    if (!item) return [];
    const ar = str(item.na || (ARABIC_RE.test(item.n || '') ? item.n : ''));
    const en = str(item.ne || (LATIN_RE.test(item.n || '') && !ARABIC_RE.test(item.n || '') ? item.n : ''));
    if (lang === 'en') return wrapLabel(en || item.n || ar, maxChars);
    if (lang === 'both') {
      if (ar && en && ar.toLowerCase() !== en.toLowerCase()) return [ar, en];
      return wrapLabel(ar || en || item.n, maxChars);
    }
    return wrapLabel(ar || item.n || en, maxChars);
  }

  // Smoothly fades a label in from its rank zoom threshold over `fadeSpan` zoom levels.
  function labelFade(z, minZoom, fadeSpan = 0.5) {
    const zv = Number(z), mz = Number(minZoom);
    if (!isNum(zv) || !isNum(mz) || zv < mz) return 0;
    if (fadeSpan <= 0 || zv >= mz + fadeSpan) return 1;
    return round(0.28 + ((zv - mz) / fadeSpan) * 0.72, 3);
  }

  // How many labels a frame may hold: about one label per 4 200 px², clamped to 24..250 so small phones stay
  // readable and large desktop screens still show a full picture.
  function maxLabelsForView(width, height, cap = 250) {
    const w = Number(width), h = Number(height);
    if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) return cap;
    return clamp(Math.round((w * h) / 4200), 24, cap);
  }

  function fontSizeForLabel(item) {
    const r = Number(item.r) || 1, k = item.k || 'hood';
    if (k === 'admin') return r >= 6 ? 15.5 : r >= 5 ? 14 : 12.5;
    if (k === 'city') return r >= 6 ? 16 : r >= 5 ? 14.5 : 13;
    if (k === 'water') return r >= 5 ? 14 : 12;
    if (k === 'green') return 11.5;
    if (k === 'landmark') return 11;
    return r >= 4 ? 13 : 12;
  }

  // Pure priority + collision layout function. Accepts screen-projected or world-normalized candidates.
  function layoutLabels(candidates, opts = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const z = isNum(opts.z) ? opts.z : 16;
    const maxLabels = isNum(opts.maxLabels) ? opts.maxLabels : 250;
    const pad = isNum(opts.padding) ? opts.padding : 4;
    const lang = opts.lang || 'ar';
    const maxChars = isNum(opts.maxChars) ? opts.maxChars : 18;
    const width = isNum(opts.width) ? opts.width : null;
    const height = isNum(opts.height) ? opts.height : null;
    const enabled = opts.enabledClasses || null;
    const measure = typeof opts.measureWidth === 'function'
      ? opts.measureWidth
      : ((line, fontSize) => line.length * fontSize * 0.58);

    const eligible = [];
    for (const c of candidates) {
      if (!c) continue;
      const k = c.k || 'hood';
      if (enabled) {
        if (enabled instanceof Set && !enabled.has(k)) continue;
        if (typeof enabled === 'object' && !(enabled instanceof Set) && enabled[k] === false) continue;
      }
      const r = clamp(Number(c.r) || 1, 1, 6);
      const minZoom = isNum(c.minZoom) ? c.minZoom : (RANK_MIN_ZOOM[r] || 16);
      const alpha = labelFade(z, minZoom, opts.fadeSpan);
      if (alpha <= 0) continue;
      const x = Number(c.x), y = Number(c.y);
      if (!isNum(x) || !isNum(y)) continue;
      if (width !== null && height !== null) {
        if (x < -40 || y < -24 || x > width + 40 || y > height + 24) continue;
      }
      eligible.push({ ...c, k, r, x, y, a: Number(c.a) || 0, minZoom, alpha });
    }

    // Priority order: rank descending, then polygon size descending, then deterministic name tie-breaker.
    eligible.sort((a, b) => (b.r - a.r) || (b.a - a.a) || String(a.n || '').localeCompare(String(b.n || ''), 'ar'));

    const placed = [];
    const boxes = [];
    const seenNear = [];

    for (const item of eligible) {
      if (placed.length >= maxLabels) break;
      const lines = Array.isArray(item.lines) && item.lines.length ? item.lines : labelLines(item, lang, maxChars);
      if (!lines.length) continue;
      const fontSize = isNum(item.fontSize) ? item.fontSize : fontSizeForLabel(item);
      const lineHeight = Math.round(fontSize * 1.25);
      let maxW = 0;
      for (const ln of lines) {
        const w = measure(ln, fontSize, item);
        if (w > maxW) maxW = w;
      }
      const dotExtra = item.k === 'landmark' ? 10 : 0;
      const w = Math.ceil(maxW + dotExtra + pad * 2);
      const h = Math.ceil(lines.length * lineHeight + pad * 2);
      const box = {
        left: item.x - w / 2,
        right: item.x + w / 2,
        top: item.y - h / 2,
        bottom: item.y + h / 2,
      };
      // Labels that straddle the viewport edge are dropped so text is never cut off mid-word.
      if (opts.keepInside && width !== null && height !== null) {
        if (box.left < 2 || box.top < 2 || box.right > width - 2 || box.bottom > height - 2) continue;
      }
      if (boxes.some(b => !(box.right < b.left || box.left > b.right || box.bottom < b.top || box.top > b.bottom))) {
        continue;
      }
      const textKey = `${item.k}:${lines.join('/')}`;
      if (seenNear.some(s => s.key === textKey && Math.hypot(s.x - item.x, s.y - item.y) < 130)) {
        continue;
      }
      boxes.push(box);
      seenNear.push({ key: textKey, x: item.x, y: item.y });
      placed.push({ ...item, lines, fontSize, lineHeight, w, h, box });
    }

    return placed;
  }

  const api = {
    MAX_PHOTOS, MAX_AREA_SIDE_KM, GAZA_BOUNDS, RANK_MIN_ZOOM, LABEL_RANK_ZOOM: RANK_MIN_ZOOM,
    PLACE_RANK, PLACE_CLASS, PLACE_KINDS,
    validLatLng, parseCoords, formatCoord, worldSize, normXY, project, unproject, metersPerPixel,
    haversine, pathLength, routePoints, bearing, pointInPolygon, polygonArea, polylabel, seaLabelPoint, bboxAround, bboxDimensionsKm, bboxAreaKm2, inBbox, boundsOf, fitZoom,
    formatDistance, formatArea, niceDistance, builtinGazaArea,
    normalizeGeo, geoOf, applyGeo, clearGeo, geoNodes, collectMapPins, filterMapPins, eventVisibleAtDate, timeRangeOfPins, searchMapPins, coverOf, cluster,
    overpassQuery, splitBbox, estimateBasemapSize, mergeOverpass, simplify, pack, unpack, stitch,
    extractNames, parseOverpass, basemapStats, inflate, validateBasemap,
    wrapLabel, labelLines, labelFade, fontSizeForLabel, maxLabelsForView, layoutLabels,
  };
  root.RelationshipGeo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
