// Request 1B — richer labels: name collection, ranking, polylabel, wrapping/fade, collision layout,
// bbox splitting/merging and v1/v2 basemap compatibility.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/geo.js');

const bbox = { s: 40, w: -100, n: 40.1, e: -99.9 };

// A mocked Overpass response exercising every label class the owner asked for (1B.4 criterion 1):
// an administrative relation, a quarter, a refugee camp, a park polygon, a hospital and a sea node.
const mockedOverpass = {
  elements: [
    // Administrative area (governorate) — relation with `out tags center`.
    {
      type: 'relation', id: 1001,
      center: { lat: 40.05, lon: -99.95 },
      tags: { type: 'boundary', boundary: 'administrative', admin_level: '5', name: 'محافظة غزة', 'name:en': 'Gaza Governorate' },
    },
    // Quarter — a `place=quarter` node.
    { type: 'node', id: 2001, lat: 40.03, lon: -99.96, tags: { place: 'quarter', name: 'حارة الدرج', 'name:en': 'Ad Darraj' } },
    // Refugee camp — tagged only in English, plus a `refugee=yes` polygon duplicate to test de-duplication.
    { type: 'node', id: 3001, lat: 40.04, lon: -99.94, tags: { place: 'suburb', name: 'Beach Camp' } },
    {
      type: 'way', id: 3002, closed: true,
      geometry: [
        { lat: 40.035, lon: -99.945 }, { lat: 40.035, lon: -99.935 },
        { lat: 40.045, lon: -99.935 }, { lat: 40.045, lon: -99.945 }, { lat: 40.035, lon: -99.945 },
      ],
      tags: { refugee: 'yes', landuse: 'residential', name: 'Beach Camp' },
    },
    // Park polygon — a concave shape so polylabel must land inside the shape.
    {
      type: 'way', id: 4001,
      geometry: [
        { lat: 40.06, lon: -99.99 }, { lat: 40.06, lon: -99.97 }, { lat: 40.065, lon: -99.97 },
        { lat: 40.065, lon: -99.985 }, { lat: 40.075, lon: -99.985 }, { lat: 40.075, lon: -99.99 },
        { lat: 40.06, lon: -99.99 },
      ],
      tags: { leisure: 'park', name: 'حديقة الجندي المجهول', 'name:en': 'Unknown Soldier Park' },
    },
    // Hospital — a named point of interest.
    { type: 'node', id: 5001, lat: 40.02, lon: -99.98, tags: { amenity: 'hospital', name: 'مستشفى الشفاء', 'name:en': 'Al-Shifa Hospital' } },
    // Sea — a named natural=sea node (rank 6, water class).
    { type: 'node', id: 6001, lat: 40.095, lon: -99.92, tags: { natural: 'sea', name: 'البحر الأبيض المتوسط', 'name:en': 'Mediterranean Sea' } },
    // University campus and market — more landmarks.
    { type: 'node', id: 7001, lat: 40.055, lon: -99.965, tags: { amenity: 'university', name: 'الجامعة الإسلامية', 'name:en': 'Islamic University' } },
    { type: 'node', id: 7002, lat: 40.045, lon: -99.955, tags: { amenity: 'marketplace', name: 'سوق الزاوية' } },
    // Unnamed park must not become a label.
    {
      type: 'way', id: 8001,
      geometry: [
        { lat: 40.01, lon: -99.99 }, { lat: 40.01, lon: -99.98 },
        { lat: 40.02, lon: -99.98 }, { lat: 40.02, lon: -99.99 }, { lat: 40.01, lon: -99.99 },
      ],
      tags: { leisure: 'park' },
    },
  ],
};

test('1B.1 every new place kind is requested and ranked', () => {
  const kinds = ['quarter', 'borough', 'district', 'locality', 'city_block', 'farm', 'isolated_dwelling', 'square', 'island', 'islet', 'sea', 'bay'];
  const q = G.overpassQuery(bbox);
  for (const k of kinds) {
    assert.ok(G.PLACE_KINDS.includes(k), `place=${k} is a supported kind`);
    assert.ok(q.includes(k), `overpassQuery asks for place=${k}`);
    assert.ok(G.PLACE_RANK[k] >= 1 && G.PLACE_RANK[k] <= 6, `place=${k} has a rank`);
  }
  for (const k of ['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet']) {
    assert.ok(G.PLACE_KINDS.includes(k), `legacy place=${k} kept`);
  }
});

test('1B.1 administrative boundaries are requested separately with tags + center', () => {
  const q = G.overpassQuery(bbox);
  const adminBlock = q.split('out tags center')[0];
  assert.match(adminBlock, /boundary"="administrative/);
  assert.match(adminBlock, /admin_level/);
  assert.match(adminBlock, /4\|5\|6\|7\|8\|9\|10/);
  assert.match(q, /out tags center/);
  assert.match(q, /out center/);
  // Landmark / named-area classes appear in the `out center` sub-query.
  assert.match(q, /place_of_worship/);
  assert.match(q, /university\|college\|school\|hospital\|marketplace/);
  assert.match(q, /beach\|bay\|sea/);
  assert.match(q, /landuse/);
});

test('1B.4 #1 mocked Overpass response yields a label of every class, ranked', () => {
  const bm = G.parseOverpass(mockedOverpass, bbox);
  assert.equal(bm.v, 2);
  assert.ok(Array.isArray(bm.areas), 'v2 basemap has an areas array');

  const all = [...bm.places, ...bm.areas];
  const byName = n => all.find(x => x.n === n || x.ne === n);

  // Administrative: governorate -> class admin, rank 6, appears at low zoom.
  const gov = byName('محافظة غزة');
  assert.ok(gov, 'admin relation produced a label');
  assert.equal(gov.k, 'admin');
  assert.equal(gov.r, 6);
  assert.equal(gov.lat, 40.05);
  assert.ok(gov.ne.includes('Gaza'));

  // Quarter -> class hood, rank 4.
  const quarter = byName('حارة الدرج');
  assert.ok(quarter);
  assert.equal(quarter.k, 'hood');
  assert.equal(quarter.r, 4);

  // Camp -> class hood, rank 3 (detected from the English "Camp" name), single label only.
  const camps = all.filter(x => /Beach Camp/.test(`${x.n} ${x.ne}`));
  assert.equal(camps.length, 1, 'duplicate camp label de-duplicated');
  assert.equal(camps[0].k, 'hood');
  assert.equal(camps[0].r, 3);

  // Park polygon -> class green, rank 2, label point inside the polygon.
  const park = byName('حديقة الجندي المجهول');
  assert.ok(park);
  assert.equal(park.k, 'green');
  assert.equal(park.r, 2);
  assert.ok(park.a > 0, 'polygon area recorded for priority ordering');
  const parkPoly = mockedOverpass.elements.find(e => e.id === 4001).geometry;
  assert.ok(parkPoly.some(() => true));
  // polylabel point must be inside the park's bounding box
  const lats = parkPoly.map(p => p.lat), lngs = parkPoly.map(p => p.lon);
  assert.ok(park.lat >= Math.min(...lats) && park.lat <= Math.max(...lats));
  assert.ok(park.lng >= Math.min(...lngs) && park.lng <= Math.max(...lngs));

  // Hospital -> class landmark, rank 2.
  const hospital = byName('مستشفى الشفاء');
  assert.ok(hospital);
  assert.equal(hospital.k, 'landmark');
  assert.equal(hospital.r, 2);
  assert.equal(hospital.ne, 'Al-Shifa Hospital');

  // Sea node -> class water, rank 6.
  const sea = byName('البحر الأبيض المتوسط');
  assert.ok(sea);
  assert.equal(sea.k, 'water');
  assert.equal(sea.r, 6);

  // Campus + market -> landmark.
  assert.equal(byName('الجامعة الإسلامية').k, 'landmark');
  assert.equal(byName('سوق الزاوية').k, 'landmark');

  // Unnamed features never become labels.
  assert.ok(!all.some(x => !x.n && !x.ne));

  // Each class appears at its documented zoom.
  const minZoomOf = k => G.RANK_MIN_ZOOM[all.find(x => x.k === k).r];
  assert.equal(minZoomOf('admin'), G.RANK_MIN_ZOOM[6]);
  assert.equal(minZoomOf('hood'), G.RANK_MIN_ZOOM[4]);
  assert.ok(G.RANK_MIN_ZOOM[6] < G.RANK_MIN_ZOOM[5]);
  assert.ok(G.RANK_MIN_ZOOM[5] < G.RANK_MIN_ZOOM[4]);
  assert.ok(G.RANK_MIN_ZOOM[4] < G.RANK_MIN_ZOOM[3]);
  assert.ok(G.RANK_MIN_ZOOM[3] < G.RANK_MIN_ZOOM[2]);
  assert.ok(G.RANK_MIN_ZOOM[2] < G.RANK_MIN_ZOOM[1]);

  for (const list of [bm.places, bm.areas]) {
    const order = list.map(x => x.r);
    assert.deepEqual(order, order.slice().sort((a, b) => b - a), 'labels sorted by rank');
  }
  // After inflation every label of the basemap is globally sorted by rank (draw order).
  const inflated = G.inflate(bm);
  const ranks = inflated.labels.map(l => l.r);
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => b - a));
});

test('1B.1 name preference: name:ar, then name, then name:en', () => {
  // `na` is omitted when it repeats `n` (keeps the file small); `n` is always the Arabic name when present.
  assert.deepEqual(
    G.extractNames({ 'name:ar': 'غزة', name: 'Gaza', 'name:en': 'Gaza City' }),
    { n: 'غزة', ne: 'Gaza City' },
  );
  assert.deepEqual(G.extractNames({ name: 'خان يونس' }), { n: 'خان يونس' });
  assert.deepEqual(G.extractNames({ name: 'الشجاعية' }), { n: 'الشجاعية' });
  assert.deepEqual(G.extractNames({ 'name:en': 'Rafah' }), { n: 'Rafah' }, 'name:en is the last resort');
  assert.equal(G.extractNames({ amenity: 'park' }), null);
  assert.equal(G.extractNames(null), null);
});

test('1B.1 places of worship switch to rank 1 in dense areas', () => {
  const low = G.parseOverpass({ elements: [
    { type: 'node', id: 1, lat: 40.05, lon: -99.95, tags: { amenity: 'place_of_worship', name: 'مسجد' } },
  ] }, bbox);
  assert.equal(low.areas.find(a => a.n === 'مسجد').r, 2);

  const many = { elements: [] };
  for (let i = 0; i < 400; i++) {
    many.elements.push({
      type: 'node', id: 1000 + i,
      lat: 40.001 + (i % 20) * 0.004, lon: -99.999 + Math.floor(i / 20) * 0.004,
      tags: { amenity: 'place_of_worship', name: `مسجد ${i}` },
    });
  }
  const dense = G.parseOverpass(many, bbox);
  const item = dense.areas.find(a => a.n === 'مسجد 0');
  assert.equal(item.r, 1, 'dense area -> appear from zoom 16');
});

test('1B.1 corrupt / out-of-area coordinates are dropped', () => {
  const withOutlier = {
    elements: [
      ...mockedOverpass.elements,
      { type: 'node', id: 9999, lat: -29.7, lon: -82.7, tags: { place: 'neighbourhood', name: 'خارج النطاق' } },
    ],
  };
  const bm = G.parseOverpass(withOutlier, bbox);
  assert.ok(![...bm.places, ...bm.areas].some(x => x.n === 'خارج النطاق'));
});

test('1B.2 polylabel lands inside a concave polygon', () => {
  const ring = [
    [40.00, -100.00], [40.10, -100.00], [40.10, -99.90], [40.00, -99.90], [40.00, -99.98], [40.08, -99.98],
    [40.08, -99.92], [40.02, -99.92], [40.02, -99.98], [40.00, -99.98],
  ];
  const p = G.polylabel(ring, 0.0001);
  assert.ok(p);
  assert.ok(p.lat > 40.0 && p.lat < 40.1);
  assert.ok(p.lng > -100 && p.lng < -99.9);
  assert.ok(p.distance > 0);
  // A square's pole of inaccessibility is its centre.
  const square = [[40, -100], [40, -99.98], [40.02, -99.98], [40.02, -100]];
  const c = G.polylabel(square, 0.0001);
  assert.ok(Math.abs(c.lat - 40.01) < 0.002 && Math.abs(c.lng + 99.99) < 0.002);
});

test('1B.2 long names wrap to at most two lines', () => {
  assert.deepEqual(G.wrapLabel('غزة', 18), ['غزة']);
  const wrapped = G.wrapLabel('مستشفى الشفاء الحكومي في مدينة غزة', 18);
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped.join(' '), 'مستشفى الشفاء الحكومي في مدينة غزة');
  assert.deepEqual(G.wrapLabel('سطر أول\nسطر ثانٍ\nسطر ثالث'), ['سطر أول', 'سطر ثانٍ']);
});

test('1B.2 label language setting picks Arabic, English or both', () => {
  const item = { n: 'غزة', na: 'غزة', ne: 'Gaza' };
  assert.deepEqual(G.labelLines(item, 'ar'), ['غزة']);
  assert.deepEqual(G.labelLines(item, 'en'), ['Gaza']);
  assert.deepEqual(G.labelLines(item, 'both'), ['غزة', 'Gaza']);
  assert.deepEqual(G.labelLines({ n: 'خان يونس' }, 'en'), ['خان يونس'], 'falls back when no English name');
  assert.deepEqual(G.labelLines({ n: 'Gaza', ne: 'Gaza' }, 'both'), ['Gaza'], 'no duplicated line');
});

test('1B.2 labels fade in around their zoom threshold', () => {
  assert.equal(G.labelFade(12, 14.5, 0.5), 0);
  assert.equal(G.labelFade(15, 14.5, 0.5), 1);
  const partial = G.labelFade(14.75, 14.5, 0.5);
  assert.ok(partial > 0 && partial < 1);
  assert.equal(G.labelFade(14.5, 14.5, 0), 1);
});

test('1B.2 collision layout: rank first, then polygon size, never overlapping', () => {
  const candidates = [
    // Two labels at the same spot: the higher rank must win.
    { n: 'مدينة غزة', k: 'city', r: 6, x: 100, y: 100, minZoom: 9 },
    { n: 'حي صغير', k: 'hood', r: 3, x: 104, y: 102, minZoom: 13.2 },
    // Same rank, different polygon size.
    { n: 'حديقة كبيرة', k: 'green', r: 2, x: 300, y: 100, a: 900000, minZoom: 14.5 },
    { n: 'حديقة صغيرة', k: 'green', r: 2, x: 304, y: 101, a: 1200, minZoom: 14.5 },
    // Far away, kept.
    { n: 'مستشفى', k: 'landmark', r: 2, x: 600, y: 400, minZoom: 14.5 },
  ];
  const placed = G.layoutLabels(candidates, { z: 16, width: 800, height: 600 });
  const names = placed.map(p => p.n);
  assert.ok(names.includes('مدينة غزة'));
  assert.ok(!names.includes('حي صغير'), 'lower rank yields the space');
  assert.ok(names.includes('حديقة كبيرة'));
  assert.ok(!names.includes('حديقة صغيرة'), 'smaller polygon yields the space');
  assert.ok(names.includes('مستشفى'));

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].box, b = placed[j].box;
      const overlap = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      assert.ok(!overlap, `${placed[i].n} and ${placed[j].n} must not overlap`);
    }
  }
});

test('1B.2 collision layout respects class toggles, zoom and the label cap', () => {
  const candidates = [
    { n: 'أ', k: 'admin', r: 6, x: 50, y: 50 },
    { n: 'ب', k: 'city', r: 5, x: 150, y: 50 },
    { n: 'ج', k: 'hood', r: 3, x: 250, y: 50 },
    { n: 'د', k: 'landmark', r: 2, x: 350, y: 50 },
    { n: 'ه', k: 'water', r: 4, x: 450, y: 50 },
  ];
  const onlyCities = G.layoutLabels(candidates, { z: 17, enabledClasses: { admin: false, city: true, hood: false, landmark: false, water: false } });
  assert.deepEqual(onlyCities.map(p => p.n), ['ب']);

  const setForm = G.layoutLabels(candidates, { z: 17, enabledClasses: new Set(['water']) });
  assert.deepEqual(setForm.map(p => p.n), ['ه']);

  const lowZoom = G.layoutLabels(candidates, { z: 10 });
  assert.deepEqual(lowZoom.map(p => p.n), ['أ'], 'only rank 6 at zoom 10');

  const many = [];
  for (let i = 0; i < 400; i++) many.push({ n: `n${i}`, k: 'landmark', r: 2, x: (i % 40) * 60, y: Math.floor(i / 40) * 60 });
  const capped = G.layoutLabels(many, { z: 17 });
  assert.ok(capped.length <= 250, 'at most ~250 labels per frame');
});

test('1B.2 hybrid labels can hide classes the raster already shows', () => {
  const candidates = [
    { n: 'مدينة', k: 'city', r: 6, x: 100, y: 100 },
    { n: 'حي', k: 'hood', r: 3, x: 400, y: 100 },
  ];
  const hybrid = G.layoutLabels(candidates, { z: 17, enabledClasses: { city: true, hood: false } });
  assert.deepEqual(hybrid.map(p => p.n), ['مدينة']);
});

test('1B.3 legacy v1 basemaps still load and inflate', () => {
  const v1 = {
    v: 1,
    bbox,
    created: '2025-01-01T00:00:00.000Z',
    roads: [{ k: 'major', n: 'Main St', p: G.pack([[40.01, -99.99], [40.02, -99.98]]) }],
    rail: [], water: [], waterLines: [], green: [],
    places: [{ n: 'غزة', t: 'city', lat: 40.05, lng: -99.95 }],
  };
  assert.doesNotThrow(() => G.validateBasemap(v1));
  const m = G.inflate(v1);
  assert.equal(m.v, 1);
  assert.equal(m.places.length, 1);
  assert.equal(m.labels.length, 1);
  assert.deepEqual(m.areas, []);
  assert.equal(m.places[0].r, 6, 'v1 city rank upgraded to the v2 table');
  assert.equal(m.places[0].k, 'city');
});

test('1B.3 v2 basemaps validate, round-trip and report stats', () => {
  const bm = G.parseOverpass(mockedOverpass, bbox);
  const json = JSON.parse(JSON.stringify(bm));
  assert.doesNotThrow(() => G.validateBasemap(json));
  assert.throws(() => G.validateBasemap({ v: 2, bbox }), /ناقص/);
  assert.throws(() => G.validateBasemap({ v: 3, bbox }), /غير صالح/);
  const st = G.basemapStats(json);
  assert.equal(st.labels, json.places.length + json.areas.length);
  assert.ok(st.areas >= 5);
  const m = G.inflate(json);
  assert.equal(m.labels.length, st.labels);
  assert.ok(m.labels.every(l => typeof l.minZoom === 'number'));
});

test('1B.3 the built-in Gaza area matches the offline tile pack bounds', () => {
  assert.deepEqual({ ...G.GAZA_BOUNDS }, { s: 31.199587, w: 34.208336, n: 31.610411, e: 34.581528 });
  const a = G.builtinGazaArea();
  assert.equal(a.builtin, true);
  assert.equal(a.detail, 'medium');
  assert.deepEqual(a.bbox, { ...G.GAZA_BOUNDS });
  assert.ok(a.sideKm <= G.MAX_AREA_SIDE_KM);
  const dims = G.bboxDimensionsKm(a.bbox);
  assert.ok(dims.widthKm < 50 && dims.heightKm < 50, 'built-in area fits the 50 km limit');
  assert.ok(dims.heightKm > 30, 'and still spans the whole strip');
});

test('1B.3 a 35 × 46 km area splits into sub-requests and merges without duplicate labels', () => {
  const b = { s: 31.199587, w: 34.208336, n: 31.610411, e: 34.581528 };
  const parts = G.splitBbox(b);
  assert.equal(parts.length, 4, '35 x 46 km -> 2x2 sub-requests');
  assert.deepEqual(parts.map(p => p.index), [1, 2, 3, 4]);
  assert.ok(parts.every(p => p.total === 4));
  // Sub-boxes tile the area exactly.
  assert.equal(parts[0].s, b.s);
  assert.equal(parts[3].n, b.n);
  assert.equal(parts[3].e, b.e);

  // Mocked Overpass responses: the same quarter + camp fall in two quadrants, the admin relation in all four.
  const quarter = { type: 'node', id: 4242, lat: 31.405, lon: 34.395, tags: { place: 'quarter', name: 'الشجاعية', 'name:en': "Shuja'iyya" } };
  const admin = { type: 'relation', id: 4747, center: { lat: 31.4, lon: 34.4 }, tags: { boundary: 'administrative', admin_level: '6', name: 'محافظة غزة' } };
  const responses = parts.map((p, i) => ({
    elements: [
      { type: 'node', id: 1000 + i, lat: p.s + 0.01, lon: p.w + 0.01, tags: { place: 'neighbourhood', name: `حي ${i + 1}` } },
      quarter, admin,
    ],
  }));
  // Also a road that is clipped by a sub-request boundary: two halves of one OSM way.
  responses[0].elements.push({
    type: 'way', id: 5555,
    geometry: [{ lat: 31.30, lon: 34.30 }, { lat: 31.40, lon: 34.394932 }],
    tags: { highway: 'primary', name: 'شارع صلاح الدين' },
  });
  responses[1].elements.push({
    type: 'way', id: 5555,
    geometry: [{ lat: 31.40, lon: 34.394932 }, { lat: 31.50, lon: 34.50 }],
    tags: { highway: 'primary', name: 'شارع صلاح الدين' },
  });

  const merged = G.mergeOverpass(responses);
  const ids = merged.elements.map(e => `${e.type}:${e.id}`);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate elements after merging');

  const bm = G.parseOverpass(merged, b, { detail: 'medium', clipBbox: true });
  const all = [...bm.places, ...bm.areas];
  const names = all.map(x => x.ne || x.n);
  assert.equal(names.filter(n => /Shuja/.test(n)).length, 1, 'the shared quarter appears once');
  assert.equal(names.filter(n => n === 'محافظة غزة').length, 1, 'the shared admin relation appears once');
  assert.equal(all.filter(x => /^حي /.test(x.n)).length, 4);

  // The clipped road was stitched back into one continuous line carrying a single label.
  assert.equal(bm.roads.length, 1);
  assert.equal(bm.roads[0].n, 'شارع صلاح الدين');
  const pts = G.unpack(bm.roads[0].p);
  assert.ok(pts.length >= 3, 'stitched geometry keeps both halves');
});

test('1B.3 splitBbox handles small and very large areas', () => {
  assert.equal(G.splitBbox({ s: 40, w: -100, n: 40.02, e: -99.98 }).length, 1);
  assert.equal(G.splitBbox({ s: 30, w: 30, n: 31, e: 31 }).length, 9, 'huge areas -> 3x3');
  assert.deepEqual(G.splitBbox({ s: 40, w: -100, n: 40.02, e: -99.98 }, { grid: 2 }).length, 4);
  assert.deepEqual(G.splitBbox({}), []);
});

test('1B.3 the download size is estimated before starting', () => {
  const est = G.estimateBasemapSize(G.GAZA_BOUNDS, 'medium');
  assert.ok(est.bytes > 1024 * 1024);
  assert.match(est.label, /م\.ب/);
  assert.equal(est.parts, 4);
  const basic = G.estimateBasemapSize(G.GAZA_BOUNDS, 'basic');
  assert.ok(basic.bytes < est.bytes, 'the basic detail level is smaller');
  assert.equal(G.estimateBasemapSize(null).bytes, 0);
});

test('1B.3 basic detail level still collects labels, medium adds minor roads', () => {
  const basic = G.overpassQuery(bbox, { detail: 'basic' });
  const medium = G.overpassQuery(bbox, { detail: 'medium' });
  assert.doesNotMatch(basic, /residential\|unclassified\|living_street\|pedestrian/);
  assert.match(medium, /residential/);
  // Labels are collected in both levels.
  for (const q of [basic, medium]) {
    assert.match(q, /out tags center/);
    assert.match(q, /place_of_worship/);
    assert.match(q, /quarter/);
  }
  assert.equal(G.parseOverpass(mockedOverpass, bbox, { detail: 'basic' }).detail, 'basic');
});

test('1B.1 a named sea whose centre is far offshore is labelled next to the coast', () => {
  // The area includes a strip of sea west of the coastline (like the Gaza bounds).
  const b = { s: 40, w: -100.1, n: 40.2, e: -99.8 };
  const mock = {
    elements: [
      // The sea relation intersects the area but its own centre is thousands of km away.
      { type: 'relation', id: 7001, center: { lat: 33.87, lon: 30.67 }, tags: { natural: 'sea', name: 'بحر الشام', 'name:en': 'Levantine Sea' } },
      // Coastline running north-south along the west edge of the area.
      {
        type: 'way', id: 7002,
        geometry: [{ lat: 40.0, lon: -99.99 }, { lat: 40.1, lon: -99.99 }, { lat: 40.2, lon: -99.99 }],
        tags: { natural: 'coastline' },
      },
      { type: 'node', id: 7003, lat: 40.1, lon: -99.9, tags: { place: 'city', name: 'مدينة الساحل' } },
    ],
  };
  const bm = G.parseOverpass(mock, b);
  const sea = bm.areas.find(a => a.k === 'water' && a.r >= 5);
  assert.ok(sea, 'the sea got a label');
  assert.equal(sea.n, 'بحر الشام');
  assert.equal(sea.r, 6, 'seas appear at the lowest zoom');
  assert.ok(sea.lng < -99.99, 'the label sits on the water side of the coastline');
  assert.ok(sea.lat >= b.s && sea.lat <= b.n, 'and inside the area');

  // No coastline -> no invented sea label.
  const noCoast = G.parseOverpass({ elements: [mock.elements[0]] }, b);
  assert.ok(!noCoast.areas.some(a => a.k === 'water'));
  assert.equal(G.seaLabelPoint([], b), null);
  assert.equal(G.seaLabelPoint([[40.1, -99.99]], null), null);
});

test('1B.2 the number of labels per frame adapts to the viewport size', () => {
  assert.equal(G.maxLabelsForView(1440, 900), 250, 'desktop keeps the 250 cap');
  const phone = G.maxLabelsForView(390, 780);
  assert.ok(phone > 24 && phone < 120, `phone shows fewer labels (${phone})`);
  assert.ok(G.maxLabelsForView(700, 900) < 250, 'small laptop shows fewer labels than a large screen');
  assert.equal(G.maxLabelsForView(0, 0), 250);
  assert.equal(G.maxLabelsForView(10, 10), 24, 'never below the floor');
});

test('1B.2 labels are kept inside the viewport when requested', () => {
  const candidates = [
    { n: 'وسط', k: 'city', r: 6, x: 200, y: 200 },
    { n: 'على الحافة', k: 'hood', r: 3, x: 3, y: 300 },     // centre almost on the left edge
    { n: 'خارج العرض', k: 'hood', r: 4, x: 500, y: 200 },     // beyond the right edge of a 400 px view
  ];
  const loose = G.layoutLabels(candidates, { z: 17, width: 400, height: 400 });
  assert.ok(loose.some(l => l.n === 'على الحافة'), 'without keepInside the edge label is drawn');
  const inside = G.layoutLabels(candidates, { z: 17, width: 400, height: 400, keepInside: true });
  assert.deepEqual(inside.map(l => l.n), ['وسط'], 'edge and out-of-view labels are dropped');
});
