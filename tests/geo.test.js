'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geo.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('parseCoords accepts decimal pairs and hemisphere letters, rejects junk', () => {
  assert.deepEqual(G.parseCoords('40.7128, -74.0060'), { lat: 40.7128, lng: -74.006 });
  assert.deepEqual(G.parseCoords('40.7128 -74.0060'), { lat: 40.7128, lng: -74.006 });
  assert.deepEqual(G.parseCoords('40.7128N 74.0060W'), { lat: 40.7128, lng: -74.006 });
  assert.deepEqual(G.parseCoords('33.9S, 18.4E'), { lat: -33.9, lng: 18.4 });
  assert.equal(G.parseCoords('91, 10'), null);
  assert.equal(G.parseCoords('abc'), null);
  assert.equal(G.parseCoords(''), null);
});

test('project / unproject round-trip and metres per pixel', () => {
  for (const [lat, lng, z] of [[40.7, -74, 12], [-33.9, 18.4, 16.5], [0, 0, 3]]) {
    const p = G.project(lat, lng, z), q = G.unproject(p.x, p.y, z);
    near(q.lat, lat, 1e-7); near(q.lng, lng, 1e-7);
  }
  near(G.metersPerPixel(0, 0), 156543.03392, 1e-3);
  assert.ok(G.metersPerPixel(60, 10) < G.metersPerPixel(0, 10));
});

test('distance, path length and area behave', () => {
  const nyc = { lat: 40.7128, lng: -74.006 }, bos = { lat: 42.3601, lng: -71.0589 };
  const d = G.haversine(nyc, bos);
  assert.ok(d > 300000 && d < 310000, 'NYC-Boston ~306 km, got ' + d);
  near(G.pathLength([nyc, bos, nyc]), 2 * d, 1e-6);
  const b = G.bboxAround(40, -100, 20);
  assert.ok(Math.abs(G.bboxAreaKm2(b) - 400) < 1, 'area ' + G.bboxAreaKm2(b));
  const sq = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }, { lat: 0.01, lng: 0.01 }, { lat: 0.01, lng: 0 }];
  const a = G.polygonArea(sq);
  assert.ok(a > 1.2e6 && a < 1.3e6, 'about 1.23 km², got ' + a);
  assert.equal(G.polygonArea(sq.slice(0, 2)), 0);
  assert.equal(G.formatDistance(450), '450 م');
  assert.equal(G.formatDistance(2500), '2.50 كم');
  assert.equal(G.niceDistance(870), 500);
  assert.equal(G.niceDistance(2300), 2000);
});

test('fitZoom makes the box fit and bbox helpers', () => {
  const b = G.bboxAround(40, -100, 20);
  const z = G.fitZoom(b, 1000, 700, 0);
  const s = G.project(b.s, b.w, z), n = G.project(b.n, b.e, z);
  assert.ok(Math.abs(n.x - s.x) <= 1000.5 && Math.abs(s.y - n.y) <= 700.5);
  assert.ok(Math.abs(n.x - s.x) > 990 || Math.abs(s.y - n.y) > 690, 'tight fit');
  assert.equal(G.inBbox(b, 40, -100), true);
  assert.equal(G.inBbox(b, 41, -100), false);
  assert.deepEqual(G.boundsOf([{ lat: 1, lng: 2 }, { lat: 3, lng: -4 }]), { s: 1, w: -4, n: 3, e: 2 });
});

test('location records: normalise, apply, clear, cover photo', () => {
  assert.equal(G.normalizeGeo({ lat: 'x', lng: 1 }), null);
  assert.equal(G.normalizeGeo({ lat: '', lng: 1 }), null);
  assert.equal(G.normalizeGeo(null), null);
  const g = G.normalizeGeo({ lat: '40.123456789', lng: -74.5, place: ' Hub ', photos: ['data:image/png;base64,AA', { src: '', caption: 'x' }, { src: 'https://e/x.jpg', caption: ' c ' }] });
  assert.deepEqual([g.lat, g.lng, g.place, g.photos.length, g.photos[1].caption], [40.123457, -74.5, 'Hub', 2, 'c']);
  const node = { id: 1, label: 'A', photo: 'https://e/avatar.png' };
  assert.equal(G.coverOf(node, null), 'https://e/avatar.png');
  G.applyGeo(node, { lat: 1, lng: 2, photos: [{ src: 'data:image/png;base64,AA' }] });
  assert.equal(G.coverOf(node, G.geoOf(node)), 'data:image/png;base64,AA');
  assert.throws(() => G.applyGeo(node, { lat: 100, lng: 0 }), /غير صالحة/);
  assert.equal(G.geoNodes([node, { id: 2, label: 'B' }]).length, 1);
  assert.equal(G.clearGeo(node), true); assert.equal(node.geo, undefined); assert.equal(G.clearGeo(node), false);
  const many = G.normalizeGeo({ lat: 0, lng: 0, photos: Array.from({ length: 30 }, (_, i) => 'p' + i) });
  assert.equal(many.photos.length, G.MAX_PHOTOS);
});

test('cluster groups close points only', () => {
  const items = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 20, y: 15 }, { id: 'c', x: 400, y: 400 }];
  const c = G.cluster(items, 50).sort((p, q) => q.count - p.count);
  assert.equal(c.length, 2); assert.deepEqual(c[0].ids.sort(), ['a', 'b']); assert.equal(c[1].count, 1);
});

test('pack/unpack and simplify keep the shape', () => {
  const pts = [[40.12345, -74.54321], [40.12355, -74.54301], [40.12999, -74.5]];
  assert.deepEqual(G.unpack(G.pack(pts)), pts);
  const line = Array.from({ length: 100 }, (_, i) => [40 + i * 1e-4, -74 + i * 1e-4]);
  const s = G.simplify(line, 1e-6);
  assert.equal(s.length, 2, 'a straight line collapses to its ends');
  const bend = [[0, 0], [0, 0.01], [0.01, 0.01]];
  assert.equal(G.simplify(bend, 1e-6).length, 3);
});

const bbox = { s: 40.0, w: -100.0, n: 40.1, e: -99.9 };
const sample = {
  elements: [
    { type: 'way', tags: { highway: 'primary', name: 'Main St' }, geometry: [{ lat: 40.01, lon: -99.99 }, { lat: 40.02, lon: -99.98 }, { lat: 40.04, lon: -99.97 }] },
    { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: 40.03, lon: -99.95 }, { lat: 40.035, lon: -99.94 }] },
    { type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: 40.03, lon: -99.95 }, { lat: 40.035, lon: -99.94 }] },
    { type: 'way', tags: { railway: 'rail' }, geometry: [{ lat: 40.05, lon: -99.99 }, { lat: 40.06, lon: -99.9 }] },
    { type: 'way', tags: { waterway: 'river' }, geometry: [{ lat: 40.07, lon: -99.99 }, { lat: 40.08, lon: -99.9 }] },
    { type: 'way', tags: { leisure: 'park', name: 'P' }, geometry: [{ lat: 40.01, lon: -99.9 }, { lat: 40.01, lon: -99.89 }, { lat: 40.02, lon: -99.89 }, { lat: 40.02, lon: -99.9 }, { lat: 40.01, lon: -99.9 }] },
    { type: 'way', tags: { building: 'yes' }, geometry: [{ lat: 40.01, lon: -99.9 }, { lat: 40.01, lon: -99.89 }, { lat: 40.02, lon: -99.89 }, { lat: 40.01, lon: -99.9 }] },
    { type: 'relation', tags: { natural: 'water', type: 'multipolygon' }, members: [
      { type: 'way', role: 'outer', geometry: [{ lat: 40.05, lon: -99.8 }, { lat: 40.05, lon: -99.7 }, { lat: 40.06, lon: -99.7 }] },
      { type: 'way', role: 'outer', geometry: [{ lat: 40.06, lon: -99.7 }, { lat: 40.06, lon: -99.8 }, { lat: 40.05, lon: -99.8 }] },
      { type: 'way', role: 'inner', geometry: [{ lat: 40.052, lon: -99.78 }, { lat: 40.052, lon: -99.76 }, { lat: 40.055, lon: -99.76 }, { lat: 40.052, lon: -99.78 }] },
    ] },
    { type: 'node', lat: 40.05, lon: -99.95, tags: { place: 'town', name: 'Springfield', 'name:ar': 'سبرينغفيلد' } },
    { type: 'node', lat: 40.06, lon: -99.96, tags: { place: 'suburb', name: 'North' } },
    { type: 'node', lat: 40.06, lon: -99.96, tags: { place: 'ocean_unknown', name: 'x' } },
  ],
};

test('overpassQuery honours the detail level', () => {
  assert.match(G.overpassQuery(bbox), /residential/);
  assert.doesNotMatch(G.overpassQuery(bbox, { detail: 'basic' }), /residential/);
  assert.match(G.overpassQuery(bbox), /out geom\(40,-100,40\.1,-99\.9\)/);
});

test('parseOverpass sorts OSM data into drawable layers', () => {
  const bm = G.parseOverpass(sample, bbox);
  assert.equal(bm.roads.length, 2, 'major + minor; footway skipped');
  assert.deepEqual(bm.roads.map(r => r.k).sort(), ['major', 'minor']);
  assert.equal(bm.roads.find(r => r.k === 'major').n, 'Main St');
  assert.equal(bm.rail.length, 1); assert.equal(bm.waterLines.length, 1);
  assert.equal(bm.green.length, 1, 'park polygon; building ignored');
  assert.equal(bm.water.length, 1, 'stitched relation outer ring becomes one polygon');
  assert.deepEqual(bm.places.map(p => p.n), ['سبرينغفيلد', 'North'], 'unknown place kinds dropped, ranked');
  const st = G.basemapStats(bm);
  assert.equal(st.roads, 2); assert.equal(st.places, 2); assert.ok(st.points > 8);
  assert.doesNotThrow(() => G.validateBasemap(JSON.parse(JSON.stringify(bm))));
  assert.throws(() => G.validateBasemap({ v: 2 }), /غير صالح/);
});

test('inflate yields drawable normalised coordinates', () => {
  const bm = G.parseOverpass(sample, bbox), m = G.inflate(bm);
  assert.equal(m.roads.length, 2);
  const r = m.roads.find(x => x.k === 'major');
  assert.ok(r.pts instanceof Float64Array && r.pts.length === 6);
  const back = G.unproject(r.pts[0] * 256, r.pts[1] * 256, 0);
  near(back.lat, 40.01, 2e-5); near(back.lng, -99.99, 2e-5);
  assert.equal(m.places[0].n, 'سبرينغفيلد'); assert.ok(m.places[0].x > 0 && m.places[0].x < 1);
});

test('stitch joins reversed and split segments into a closed ring', () => {
  const a = [[0, 0], [0, 1], [1, 1]], b = [[0, 0], [1, 0], [1, 1]];
  const rings = G.stitch([a, b]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0][0].join(), rings[0][rings[0].length - 1].join());
});

test('collectMapPins separates entity, shared and personal event locations with stable keys', () => {
  const nodes = [
    { id: 1, schema: 'Person', geo: { lat: 31, lng: 34 }, events: [{ id: 'a', geo: { lat: 31.1, lng: 34.1 } }, { id: 'b' }] },
    { id: 2, schema: 'Event', geo: { lat: 31.2, lng: 34.2 } },
    { id: 3, schema: 'Person', events: [{ id: 'a', geo: { lat: 31.3, lng: 34.3 } }] },
  ];
  const list = G.collectMapPins(nodes);
  assert.deepEqual(list.map(p => [p.key, p.kind]), [['n:1', 'entity'], ['e:1:a', 'personal-event'], ['n:2', 'shared-event'], ['e:3:a', 'personal-event']]);
  assert.deepEqual(G.collectMapPins(nodes, new Set(['1'])).map(p => p.key), ['n:1', 'e:1:a']);
  assert.equal(G.collectMapPins(nodes, new Set()).length, 4);
  assert.equal(G.collectMapPins([{ id: 1, schema: 'Event', events: [{ id: 'e', geo: { lat: 0, lng: 0 } }] }]).length, 0);
});

test('route interpolation is great-circle, finite at antipodes and crosses the antimeridian', () => {
  const a = { lat: 0, lng: 170 }, b = { lat: 0, lng: -170 };
  const points = G.routePoints(a, b, 4);
  assert.deepEqual(points[0], a); assert.deepEqual(points[4], b);
  assert.ok(Math.abs(Math.abs(points[2].lng) - 180) < 1e-7);
  near(G.pathLength(points), G.haversine(a, b), 1e-5);
  const polar = G.routePoints({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }, 8);
  assert.ok(polar.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)));
  assert.deepEqual(G.routePoints({ lat: 1, lng: 2 }, { lat: 1, lng: 2 }, 2), [{lat: 1, lng: 2}, {lat: 1, lng: 2}, {lat: 1, lng: 2}]);
  assert.deepEqual(G.routePoints({ lat: 91, lng: 0 }, b), []);
  near(G.bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), 90);
  near(G.bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 0);
  assert.equal(G.bearing(null, b), null);
});

test('normalise optional route destination without accepting malformed coordinates', () => {
  const g = G.normalizeGeo({ lat: 31, lng: 34, to: { lat: '31.1234567', lng: '34.8', place: ' رفح ' } });
  assert.deepEqual(g.to, { lat: 31.123457, lng: 34.8, place: 'رفح' });
  assert.equal(G.normalizeGeo({ lat: 31, lng: 34, to: { lat: 91, lng: 2 } }), null);
  assert.equal(G.normalizeGeo({ lat: 31, lng: 34, to: { lat: '', lng: 2 } }), null);
  assert.ok(!('to' in G.normalizeGeo({ lat: 31, lng: 34 })));
});

test('filterMapPins combines kind, event and entity type with partial date ranges', () => {
  const C = require('../src/chronology.js');
  const nodes = [{ id: '1', schema: 'Person', geo: { lat: 0, lng: 0 }, events: [
    { id: 'a', type: 'travel', date: '2025', datePrecision: 'approx', geo: { lat: 1, lng: 1 } },
    { id: 'b', type: 'meeting', datePrecision: 'unknown', geo: { lat: 2, lng: 2 } },
  ] }, { id: '2', schema: 'Event', eventType: 'travel', date: '2026-04', datePrecision: 'approx', geo: { lat: 3, lng: 3 } }];
  const pins = G.collectMapPins(nodes);
  const f = o => G.filterMapPins(pins, o, C.dateRange).map(p => p.key);
  assert.deepEqual(f({ eventTypes: ['travel'] }), ['n:1', 'e:1:a', 'n:2']);
  assert.deepEqual(f({ kinds: { entity: false }, entityTypes: ['Person'] }), ['e:1:a', 'e:1:b']);
  assert.deepEqual(f({ from: '2025-06-01', to: '2025-06-30' }), ['n:1', 'e:1:a', 'e:1:b']);
  assert.deepEqual(f({ to: '2024-12-31' }), ['n:1', 'e:1:b']);
});

test('map time filtering handles partial dates, rolling windows and undated events', () => {
  const C = require('../src/chronology.js');
  const visible = (ev, date, mode = 'cumulative', months = 12) => G.eventVisibleAtDate(ev, date, mode, months, C.dateRange);
  const year = { date: '2025', datePrecision: 'approx' }, month = { date: '2026-02', datePrecision: 'approx' };
  assert.equal(visible(year, '2025-01-01'), true);
  assert.equal(visible(month, '2026-01-31'), false);
  assert.equal(visible(month, '2026-02-01'), true);
  assert.equal(visible(year, '2026-06-01', 'window', 6), true);
  assert.equal(visible(year, '2026-12-31', 'window', 6), false);
  assert.equal(visible({ datePrecision: 'unknown' }, '2020-01-01'), true);
  const pins = G.collectMapPins([{ id: 1, events: [{ id: 1, ...year, geo: { lat: 0, lng: 0 } }, { id: 2, ...month, geo: { lat: 1, lng: 1 } }, { id: 3, geo: { lat: 2, lng: 2 } }] }]);
  assert.deepEqual(G.timeRangeOfPins(pins, C.dateRange), { min: '2025-01-01', max: '2026-02-28', count: 2 });
  assert.equal(G.timeRangeOfPins(pins.slice(0, 1), C.dateRange), null);
});

test('map search matches Arabic orthographic variants across entities, events and places', () => {
  const C = require('../src/chronology.js');
  const all = G.collectMapPins([{ id: 1, label: 'أَحمد', schema: 'Person', profile: { role: 'مُدير' }, geo: { lat: 31, lng: 34, address: 'غزة القديمة' }, events: [{ id: 'x', title: 'إجتماع', geo: { lat: 31.1, lng: 34.1, note: 'حَي الرمال' } }] }]);
  const search = q => G.searchMapPins(all, q, C.norm).map(x => x.key);
  assert.deepEqual(search('احمد'), ['n:1', 'e:1:x']);
  assert.deepEqual(search('اجتماع'), ['e:1:x']);
  assert.deepEqual(search('غزه القديمه'), ['n:1']);
  assert.deepEqual(search('مدير'), ['n:1', 'e:1:x']);
  assert.deepEqual(search('حي الرمال'), ['e:1:x']);
  assert.deepEqual(search(''), []);
});

test('pointInPolygon handles edges, concavity and the antimeridian', () => {
  const p = [{ lat: 0, lng: 0 }, { lat: 0, lng: 4 }, { lat: 4, lng: 4 }, { lat: 4, lng: 0 }];
  assert.equal(G.pointInPolygon({ lat: 2, lng: 2 }, p), true);
  assert.equal(G.pointInPolygon({ lat: 0, lng: 2 }, p), true);
  assert.equal(G.pointInPolygon({ lat: 5, lng: 2 }, p), false);
  assert.equal(G.pointInPolygon({ lat: 2, lng: 2 }, p.slice(0, 2)), false);
  const crossing = [{ lat: -1, lng: 179 }, { lat: -1, lng: -179 }, { lat: 1, lng: -179 }, { lat: 1, lng: 179 }];
  assert.equal(G.pointInPolygon({ lat: 0, lng: 180 }, crossing), true);
  assert.equal(G.pointInPolygon({ lat: 0, lng: 175 }, crossing), false);
  assert.equal(G.pointInPolygon({ lat: 0, lng: 0 }, crossing), false);
});
