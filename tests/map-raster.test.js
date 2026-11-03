'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/map-raster.js');
const G = require('../src/geo.js');

const gazaBounds = { w: 34.208336, s: 31.199587, e: 34.581528, n: 31.610411 };

test('nativeZoom clamps to [minzoom, maxzoom] andrasterAlpha fades below minzoom', () => {
  assert.equal(R.nativeZoom(11, 11, 17), 11);
  assert.equal(R.nativeZoom(14.3, 11, 17), 14);
  assert.equal(R.nativeZoom(14.6, 11, 17), 15);
  assert.equal(R.nativeZoom(18, 11, 17), 17, 'over-zoom 18 uses native 17');
  assert.equal(R.nativeZoom(19, 11, 17), 17, 'over-zoom 19 uses native 17');
  assert.equal(R.nativeZoom(8, 11, 17), 11);

  assert.equal(R.rasterAlpha(11, 11), 1);
  assert.equal(R.rasterAlpha(15, 11), 1);
  assert.ok(R.rasterAlpha(10.2, 11) > 0 && R.rasterAlpha(10.2, 11) < 1);
  assert.equal(R.rasterAlpha(9, 11), 0);
});

test('tileRangeForBounds and tileInBounds match the Gaza MBTiles tile range', () => {
  const r11 = R.tileRangeForBounds(gazaBounds, 11);
  assert.deepEqual(r11, { minX: 1218, maxX: 1220, minY: 834, maxY: 837 });
  assert.equal(R.tileInBounds(11, 1219, 835, gazaBounds), true);
  assert.equal(R.tileInBounds(11, 1210, 835, gazaBounds), false);
  assert.equal(R.tileInBounds(11, -1, 835, gazaBounds), false);
  assert.equal(R.tileInBounds(11, 2048, 835, gazaBounds), false);
  assert.equal(R.tileInBounds(11, 100, 100, null), true);
});

test('tilesForView computes visible tiles, screen positions, and over-zoom scaling', () => {
  const center = { lat: 31.42, lng: 34.38 };
  const list13 = R.tilesForView({
    lat: center.lat,
    lng: center.lng,
    z: 13,
    width: 800,
    height: 600,
    minzoom: 11,
    maxzoom: 17,
    bounds: gazaBounds,
  });
  assert.ok(list13.length >= 6 && list13.length <= 30);
  for (const t of list13) {
    assert.equal(t.z, 13);
    assert.equal(t.scale, 1);
    assert.equal(t.size, 256);
    assert.equal(R.tileInBounds(t.z, t.x, t.y, gazaBounds), true);
  }
  // Sorted center-first
  assert.ok(list13[0].dist <= list13[list13.length - 1].dist);

  // Over-zoom at z=19 scales z=17 tiles by 2^(19-17) = 4 (1024 px per tile)
  const list19 = R.tilesForView({
    lat: center.lat,
    lng: center.lng,
    z: 19,
    width: 800,
    height: 600,
    minzoom: 11,
    maxzoom: 17,
    bounds: gazaBounds,
  });
  assert.ok(list19.length >= 1 && list19.length <= 9);
  assert.equal(list19[0].z, 17);
  assert.equal(list19[0].scale, 4);
  assert.equal(list19[0].size, 1024);

  // Far below minzoom returns no tiles
  const list8 = R.tilesForView({ lat: center.lat, lng: center.lng, z: 8, width: 800, height: 600, minzoom: 11, maxzoom: 17, bounds: gazaBounds });
  assert.equal(list8.length, 0);

  // View completely outside bounds returns no tiles
  const outside = R.tilesForView({ lat: 40.7, lng: -74.0, z: 13, width: 800, height: 600, minzoom: 11, maxzoom: 17, bounds: gazaBounds });
  assert.equal(outside.length, 0);
});

test('parentFallback finds ancestor tile at z-1..z-3 and computes exact sub-rectangle', () => {
  // Child tile at z=15, x=19519 (odd -> right half of parent), y=13356 (even -> top half of parent)
  const cached14 = new Set(['14/9759/6678']);
  const pf1 = R.parentFallback(15, 19519, 13356, cached14, 11, 3, 256);
  assert.deepEqual(pf1, {
    z: 14,
    x: 9759,
    y: 6678,
    key: '14/9759/6678',
    dz: 1,
    srcX: 128,
    srcY: 0,
    srcW: 128,
    srcH: 128,
  });

  // Grandparent at z-2 (dz=2 => factor 4, sub-rectangle 64x64)
  const cached13 = new Set(['13/4879/3339']);
  const pf2 = R.parentFallback(15, 19519, 13357, cached13, 11, 3, 256);
  assert.deepEqual(pf2, {
    z: 13,
    x: 4879,
    y: 3339,
    key: '13/4879/3339',
    dz: 2,
    srcX: 192, // 19519 % 4 === 3 -> 3 * 64 = 192
    srcY: 64,  // 13357 % 4 === 1 -> 1 * 64 = 64
    srcW: 64,
    srcH: 64,
  });

  // Great-grandparent at z-3 (dz=3 => factor 8, sub-rectangle 32x32)
  const cached12 = new Set(['12/2439/1669']);
  const pf3 = R.parentFallback(15, 19519, 13357, cached12, 11, 3, 256);
  assert.equal(pf3.dz, 3);
  assert.equal(pf3.z, 12);
  assert.equal(pf3.srcW, 32);
  assert.equal(pf3.srcH, 32);

  // None cached -> null
  assert.equal(R.parentFallback(15, 19519, 13357, new Set(), 11, 3, 256), null);
});

test('createLruCache evicts least-recently-used entries by count and byte budget and closes ImageBitmaps', () => {
  const closed = [];
  const makeBmp = id => ({ id, close() { closed.push(id); } });
  const lru = R.createLruCache(3, 1000);
  lru.set('a', makeBmp('a'), 300);
  lru.set('b', makeBmp('b'), 300);
  lru.set('c', makeBmp('c'), 300);
  assert.equal(lru.size, 3);
  assert.equal(lru.bytes, 900);

  // Touch 'a' so 'b' becomes the oldest
  assert.equal(lru.get('a').id, 'a');
  lru.set('d', makeBmp('d'), 300);
  assert.equal(lru.has('b'), false);
  assert.deepEqual(closed, ['b']);
  assert.deepEqual(lru.keys(), ['c', 'a', 'd']);

  // Large entry evicts multiple items to fit byte cap
  lru.set('big', makeBmp('big'), 800);
  assert.deepEqual(lru.keys(), ['big']);
  assert.equal(lru.bytes, 800);
  lru.clear();
  assert.equal(lru.size, 0);
  assert.equal(lru.bytes, 0);
});

test('builtinAreaFromInfo, basemap state helpers and attributionFor behave as specified', () => {
  const info = {
    available: true,
    name: 'Gaza Copernicus OSM Background z11-z17',
    bounds: gazaBounds,
    minzoom: 11,
    maxzoom: 17,
    attribution: '© OpenStreetMap contributors; basemap © European Commission / Eurostat GISCO',
  };
  const area = R.builtinAreaFromInfo(info, G.bboxAreaKm2);
  assert.equal(area.name, 'منطقة غزة');
  assert.equal(area.builtin, true);
  assert.ok(area.areaKm2 > 1550 && area.areaKm2 < 1650);

  // Default basemap selection rules (1.4)
  assert.equal(R.resolveInitialBasemap({ saved: null, rasterAvailable: true, hasVector: false }), 'raster');
  assert.equal(R.resolveInitialBasemap({ saved: null, rasterAvailable: true, hasVector: true }), 'vector');
  assert.equal(R.resolveInitialBasemap({ saved: 'hybrid', rasterAvailable: true, hasVector: false }), 'hybrid');
  assert.equal(R.resolveInitialBasemap({ saved: 'raster', rasterAvailable: false, hasVector: false }), 'vector');

  // Cycling with B key
  assert.equal(R.nextBasemap('vector', true), 'raster');
  assert.equal(R.nextBasemap('raster', true), 'hybrid');
  assert.equal(R.nextBasemap('hybrid', true), 'vector');
  assert.equal(R.nextBasemap('vector', false), 'vector');

  // Attribution follows active basemap
  assert.match(R.attributionFor('raster', info), /Eurostat GISCO/);
  assert.match(R.attributionFor('vector', info), /مساهمو OpenStreetMap/);
  assert.match(R.attributionFor('hybrid', info), /مساهمو OpenStreetMap.*Eurostat GISCO/);

  // Outside-view detection
  assert.equal(R.isRectOutsideView({ x: 100, y: 100, w: 300, h: 300 }, 800, 600), false);
  assert.equal(R.isRectOutsideView({ x: -500, y: 100, w: 300, h: 300 }, 800, 600), true);
});
