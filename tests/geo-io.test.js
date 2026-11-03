'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IO = require('../src/geo-io.js');
const data = { nodes: [
  { id: 1, label: '<script> & أحمد', schema: 'Person', geo: { lat: 31, lng: 34, place: 'غزة', photos: [{ src: 'data:image/png;base64,AA', caption: 'صورة' }] }, events: [{ id: 'e1', title: 'حدث', type: 'meeting', date: '2020', datePrecision: 'year', geo: { lat: 31.1, lng: 34.1 } }] },
  { id: 2, label: 'حدث عام', schema: 'Event', eventType: 'meeting', geo: { lat: 30, lng: 35 } },
], zones: [
  { id: 'a', name: 'دائرة', color: '#abcdef', shape: 'circle', center: { lat: 31, lng: 34 }, radius: 1000, photos: [{ src: 'data:image/png;base64,AA', caption: 'صورة' }] },
  { id: 'b', name: 'مستطيل', color: '#00aaff', shape: 'rectangle', points: [{ lat: 30, lng: 33 }, { lat: 31, lng: 34 }] },
  { id: 'c', name: 'مضلع', color: '#d4ff3f', shape: 'polygon', points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }] },
] };
test('GeoJSON export uses lon/lat, closes polygons, optionally includes photos, and preserves supported shapes', () => {
  const plain = IO.toGeoJSON(data), rich = IO.toGeoJSON(data, { photos: true });
  assert.deepEqual(plain.features[0].geometry.coordinates, [34, 31]);
  assert.equal(JSON.stringify(plain).includes('data:image'), false);
  assert.equal(JSON.stringify(rich).includes('data:image'), true);
  for (const f of plain.features.filter(f => f.geometry.type === 'Polygon')) assert.deepEqual(f.geometry.coordinates[0].at(-1), f.geometry.coordinates[0][0]);
  const parsed = IO.parseGeoJSON(JSON.stringify(rich), { photos: true });
  assert.equal(parsed.points.length, 3); assert.deepEqual(parsed.zones.map(z => z.shape), ['circle', 'rectangle', 'polygon']);
  assert.equal(parsed.points[0].name, '<script> & أحمد'); assert.equal(parsed.points[0].geo.photos.length, 1);
  assert.equal(parsed.zones[0].radius, 1000); assert.deepEqual(parsed.zones[1].points, data.zones[1].points);
  assert.equal(parsed.warnings.length, 0);
});
test('KML escapes text, reads its own export without executing markup, and retains shapes/photos', () => {
  const kml = IO.toKML(data, { photos: true });
  assert.ok(kml.includes('&lt;script&gt; &amp; أحمد')); assert.ok(!kml.includes('<script>'));
  const parsed = IO.parseKML(kml, { photos: true });
  assert.equal(parsed.points.length, 3); assert.equal(parsed.zones.length, 3); assert.equal(parsed.points[0].name, '<script> & أحمد');
  assert.equal(parsed.zones[0].shape, 'circle'); assert.equal(parsed.zones[0].photos.length, 1); assert.deepEqual(parsed.warnings, []);
});
test('imports standard namespace-prefixed KML and skips unsupported geometries without mutating anything', () => {
  const result = IO.parseKML('<?xml version="1.0"?><k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Document><k:Placemark><k:name>A &amp; B</k:name><k:Point><k:coordinates>34,31,0</k:coordinates></k:Point></k:Placemark><k:Placemark><k:LineString><k:coordinates>1,2 3,4</k:coordinates></k:LineString></k:Placemark></k:Document></k:kml>');
  assert.equal(result.points[0].name, 'A & B'); assert.deepEqual(result.points[0].geo, { lat: 31, lng: 34 }); assert.equal(result.warnings.length, 1);
});
test('rejects unsafe XML entities, malformed XML, oversized files, and reports invalid geometry', () => {
  assert.throws(() => IO.parseKML('<!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml>&xxe;</kml>'), /غير مسموحة/);
  assert.throws(() => IO.parseKML('<kml><Document></kml>'), /متطابقة/);
  assert.throws(() => IO.parseKML('<kml>&xxe;</kml>'), /غير مدعوم/);
  assert.throws(() => IO.parseGeoJSON(' '.repeat(IO.LIMIT + 1)), /10/);
  const f = coords => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords } });
  const parsed = IO.parseGeoJSON({ type: 'FeatureCollection', features: [f([181, 0]), f([1, '2']), f([0, 0])] });
  assert.equal(parsed.points.length, 1); assert.equal(parsed.warnings.length, 2);
});
test('does not silently fill polygon holes', () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'hole' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[0,1],[1,1],[0,0]], [[0,0],[0,.1],[.1,.1],[0,0]]] } }] };
  const r = IO.parseGeoJSON(fc); assert.equal(r.zones.length, 0); assert.equal(r.warnings.length, 1);
});
test('uses the displayed polygon instead of conflicting circle metadata', () => {
  const fc = IO.toGeoJSON(data); const f = fc.features.find(x => x.properties.name === 'دائرة');
  f.geometry.coordinates[0][0][0] += 1;
  f.geometry.coordinates[0][f.geometry.coordinates[0].length - 1] = f.geometry.coordinates[0][0].slice();
  const r = IO.parseGeoJSON(fc); assert.equal(r.zones[0].shape, 'polygon'); assert.match(r.warnings[0], /لا يطابق/);
});
test('accepts null GeoJSON properties, preserves valid destinations and ignores photos by default', () => {
  const fc = IO.toGeoJSON(data, { photos: true }); fc.features[0].properties.relationshipMap.geo.to = { lat: 32, lng: 35, place: 'مقصد' };
  fc.features.push({ type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [1, 2] } });
  const r = IO.parseGeoJSON(fc); assert.deepEqual(r.points[0].geo.to, { lat: 32, lng: 35, place: 'مقصد' }); assert.equal(r.points[0].geo.photos, undefined); assert.equal(r.points.at(-1).name, 'موقع مستورد');
});

test('geo interchange excludes profile secrets by default and includes them only by request', () => {
  const d = { nodes: [{id:1,label:'A',schema:'Person',geo:{lat:31,lng:34},profile:{personal:{idNumber:'secret-id',phone:'secret-phone'},health:{notes:'secret-health'},role:{title:'منسق'},family:[{id:'f1',name:'X',entityId:'2',phone:'secret-family'}]}}], edges: [] };
  for (const kml of [false,true]) {
    const value=kml?IO.toKML(d):JSON.stringify(IO.toGeoJSON(d));
    assert.equal(value.includes('secret-'),false);assert.match(value,/منسق/);
    const full=kml?IO.toKML(d,{sensitive:true}):JSON.stringify(IO.toGeoJSON(d,{sensitive:true}));
    assert.match(full,/secret-id/);assert.match(full,/secret-family/);
    const parsed=kml?IO.parseKML(full):IO.parseGeoJSON(full);
    assert.equal(parsed.points[0].profile.personal.idNumber,'secret-id');
    assert.equal(parsed.points[0].profile.family[0].entityId,undefined);
  }
});
