'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMbtiles, buildTilepack } = require('../scripts/build-tilepack.js');
const tilesMod = require('../server/tiles.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-tiles-test-'));
const mbtilesPath = path.join(tmpDir, 'synthetic.mbtiles');
const packPath = path.join(tmpDir, 'synthetic.tilepack');
const dataFile = path.join(tmpDir, 'data.json');
const ADMIN_PASSWORD = 'tiles-test-password-123';

// Minimal valid 1x1 WebP image bytes
const TINY_WEBP_A = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const TINY_WEBP_B = Buffer.from('UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEAAwA0JaQAA3AA/v89WAAAAA==', 'base64');

let server, base, cookie = '';
const afetch = (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });

test.before(async () => {
  // Build a tiny synthetic MBTiles (TMS rows) and convert it to a .tilepack (XYZ rows)
  createMbtiles(mbtilesPath, {
    name: 'Gaza Copernicus OSM Background z11-z17',
    format: 'webp',
    minzoom: '11',
    maxzoom: '17',
    bounds: '34.208336,31.199587,34.581528,31.610411',
    attribution: '© OpenStreetMap contributors; basemap © European Commission / Eurostat GISCO',
  }, [
    // z=11, x=1219, XYZ y=835 -> TMS tile_row = (2^11 - 1 - 835) = 1212
    { z: 11, x: 1219, tmsRow: 1212, data: TINY_WEBP_A },
    // z=14, x=9755, XYZ y=6680 -> TMS tile_row = (2^14 - 1 - 6680) = 9703
    { z: 14, x: 9755, tmsRow: 9703, data: TINY_WEBP_B },
  ]);
  const built = buildTilepack(mbtilesPath, packPath);
  assert.equal(built.tileCount, 2);

  process.env.DB_ENGINE = 'file';
  process.env.DATA_FILE = dataFile;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.OFFLINE_TILES_FILE = packPath;

  const { pool, _reset } = require('../server/file-pool.js');
  _reset?.();
  const { getAdmin } = require('../server/auth.js');
  await getAdmin();
  const { app } = require('../server/app.js');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  void pool;
});

test.after(async () => {
  tilesMod._reset();
  if (server) await new Promise(resolve => server.close(resolve));
  delete process.env.OFFLINE_TILES_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('tiles routes require authentication just like other /api routes', async () => {
  const r1 = await fetch(`${base}/api/tiles/info`);
  assert.equal(r1.status, 401);
  const r2 = await fetch(`${base}/api/tiles/11/1219/835.webp`);
  assert.equal(r2.status, 401);
});

test('GET /api/tiles/info returns metadata and bounds when the pack is present', async () => {
  process.env.OFFLINE_TILES_FILE = packPath;
  const r = await afetch(`${base}/api/tiles/info`);
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.available, true);
  assert.equal(info.name, 'Gaza Copernicus OSM Background z11-z17');
  assert.equal(info.minzoom, 11);
  assert.equal(info.maxzoom, 17);
  assert.equal(info.tileSize, 256);
  assert.deepEqual(info.bounds, { w: 34.208336, s: 31.199587, e: 34.581528, n: 31.610411 });
  assert.match(info.attribution, /OpenStreetMap/);
  assert.match(info.attribution, /Eurostat GISCO/);
});

test('GET /api/tiles/:z/:x/:y.webp serves flipped XYZ tiles, ETag, Cache-Control and 304', async () => {
  process.env.OFFLINE_TILES_FILE = packPath;
  const hit1 = await afetch(`${base}/api/tiles/11/1219/835.webp`);
  assert.equal(hit1.status, 200);
  assert.equal(hit1.headers.get('content-type'), 'image/webp');
  assert.equal(hit1.headers.get('cache-control'), 'public, max-age=86400');
  const etag = hit1.headers.get('etag');
  assert.ok(etag && etag.startsWith('"t-'));
  const bytes1 = Buffer.from(await hit1.arrayBuffer());
  assert.deepEqual(bytes1, TINY_WEBP_A);

  // Conditional request with matching ETag returns 304 Not Modified with empty body
  const cachedRes = await afetch(`${base}/api/tiles/11/1219/835.webp`, { headers: { 'if-none-match': etag } });
  assert.equal(cachedRes.status, 304);
  assert.equal((await cachedRes.arrayBuffer()).byteLength, 0);

  // Second tile at z=14
  const hit2 = await afetch(`${base}/api/tiles/14/9755/6680.webp`);
  assert.equal(hit2.status, 200);
  assert.deepEqual(Buffer.from(await hit2.arrayBuffer()), TINY_WEBP_B);

  // Unindexed tile (e.g. unflipped TMS row 1212) is a 404 miss
  const miss = await afetch(`${base}/api/tiles/11/1219/1212.webp`);
  assert.equal(miss.status, 404);
});

test('when the pack file is missing, /api/tiles/info returns available:false (not an error) and tiles 404', async () => {
  process.env.OFFLINE_TILES_FILE = path.join(tmpDir, 'does-not-exist.tilepack');
  const r = await afetch(`${base}/api/tiles/info`);
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.available, false);
  assert.equal(info.bounds, null);

  const tileRes = await afetch(`${base}/api/tiles/11/1219/835.webp`);
  assert.equal(tileRes.status, 404);
  process.env.OFFLINE_TILES_FILE = packPath;
});

test('path-traversal and out-of-range z/x/y parameters are rejected safely', async () => {
  process.env.OFFLINE_TILES_FILE = packPath;
  const badPaths = [
    '/api/tiles/-1/0/0.webp',
    '/api/tiles/25/0/0.webp',
    '/api/tiles/2/4/0.webp',       // x=4 is out of range for z=2 (0..3)
    '/api/tiles/2/0/4.webp',       // y=4 is out of range for z=2 (0..3)
    '/api/tiles/11/abc/835.webp',
    '/api/tiles/11/1219/835.png',
    '/api/tiles/..%2F..%2Fpackage.json',
    '/api/tiles/11/..%2Fserver/app.webp',
  ];
  for (const p of badPaths) {
    const res = await afetch(base + p);
    assert.ok(res.status === 400 || res.status === 404, `Expected 400/404 for ${p}, got ${res.status}`);
  }
});

test('when gaza.tilepack is missing but gaza_copernicus_osm_z11-z17.mbtiles is present, server auto-builds pack in pure JS', async () => {
  const autoDir = path.join(tmpDir, 'auto-pack');
  fs.mkdirSync(autoDir, { recursive: true });
  const autoMbtiles = path.join(autoDir, 'gaza_copernicus_osm_z11-z17.mbtiles');
  const autoPack = path.join(autoDir, 'gaza.tilepack');
  fs.copyFileSync(mbtilesPath, autoMbtiles);
  assert.equal(fs.existsSync(autoPack), false);

  process.env.OFFLINE_TILES_FILE = autoPack;
  tilesMod._reset();
  const r = await afetch(`${base}/api/tiles/info`);
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.available, true);
  assert.equal(fs.existsSync(autoPack), true, 'gaza.tilepack should be auto-generated on first request');

  const hit = await afetch(`${base}/api/tiles/11/1219/835.webp`);
  assert.equal(hit.status, 200);
  assert.deepEqual(Buffer.from(await hit.arrayBuffer()), TINY_WEBP_A);
  process.env.OFFLINE_TILES_FILE = packPath;
  tilesMod._reset();
});

