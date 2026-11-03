// The desktop app's backend: single-file storage, first-run password, restart persistence, port fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startBackend, randomPassword } = require('../desktop/backend.js');
const { writeTilepack } = require('../scripts/build-tilepack.js');
const tilesMod = require('../server/tiles.js');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-desktop-'));
const dataFile = path.join(dir, 'data', 'relationship-map.json');
const json = { 'content-type': 'application/json' };

async function login(b, password) {
  const r = await fetch(`${b.url}api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'admin', password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

test('first start creates the admin with a random password; data survives a restart', async () => {
  delete process.env.ADMIN_PASSWORD;
  let b = await startBackend({ appDir: root, dataFile, port: 47931 });
  try {
    assert.ok(b.initialPassword && b.initialPassword.length >= 10);
    assert.equal((await login(b, 'wrong-password')).status, 401);
    const { status, cookie } = await login(b, b.initialPassword);
    assert.equal(status, 200);
    const h = { ...json, cookie };
    const put = await fetch(`${b.url}api/graph`, { method: 'PUT', headers: h, body: JSON.stringify({ nodes: [{ id: 1, label: 'أ', schema: 'Person' }, { id: 2, label: 'ب', schema: 'Person' }], edges: [{ id: 1, source: 1, target: 2, type: 'Associate' }] }) });
    assert.equal(put.status, 200);
    const page = await fetch(b.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
  } finally { await b.stop(); }

  const pw = b.initialPassword;
  // A different port here only keeps the test's own HTTP client from reusing a connection to the stopped server.
  b = await startBackend({ appDir: root, dataFile, port: 47941 });
  try {
    assert.equal(b.initialPassword, null, 'the password is shown only on the first run');
    const { status, cookie } = await login(b, pw);
    assert.equal(status, 200);
    const g = await (await fetch(`${b.url}api/graph`, { headers: { cookie } })).json();
    assert.equal(g.nodes.length, 2);
    assert.equal(g.edges.length, 1);
    assert.ok(fs.existsSync(dataFile));
  } finally { await b.stop(); }
});

test('resetting the password signs everyone out and the new one works', async () => {
  const b = await startBackend({ appDir: root, dataFile, port: 47945 });
  try {
    const old = fs.readFileSync(dataFile, 'utf8');
    const next = await b.resetPassword();
    assert.notEqual(fs.readFileSync(dataFile, 'utf8'), old);
    assert.equal((await login(b, next)).status, 200);
  } finally { await b.stop(); }
});

test('the next free port is used when the first one is taken', async () => {
  const a = await startBackend({ appDir: root, dataFile, port: 47950 });
  const b = await startBackend({ appDir: root, dataFile, port: 47950 });
  try { assert.equal(b.port, a.port + 1); } finally { await b.stop(); await a.stop(); }
});

test('a .bak copy is kept next to the data file', async () => {
  const b = await startBackend({ appDir: root, dataFile, port: 47960 });
  await b.stop();
  assert.ok(fs.existsSync(`${dataFile}.bak`));
});

test('random passwords are long and differ', () => {
  assert.notEqual(randomPassword(), randomPassword());
  assert.equal(randomPassword(16).length, 16);
});

test('desktop backend resolves extraResources tilepack via process.resourcesPath and serves tiles', async () => {
  const resDir = path.join(dir, 'resources');
  const packFile = path.join(resDir, 'offline_map', 'gaza.tilepack');
  const sampleBlob = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
  writeTilepack(packFile, { name: 'Desktop Pack', minzoom: 11, maxzoom: 17, bounds: '34.2,31.2,34.5,31.6', attribution: '© OSM' }, [
    { z: 11, x: 1219, y: 835, data: sampleBlob },
  ]);
  // The bundled vector map ships next to the tile pack in `extraResources` (Request 1B).
  const vectorFile = path.join(resDir, 'offline_map', 'gaza.vectormap.json');
  fs.writeFileSync(vectorFile, JSON.stringify({
    v: 2,
    bbox: { s: 31.199587, w: 34.208336, n: 31.610411, e: 34.581528 },
    created: '2025-11-01T00:00:00.000Z',
    roads: [], rail: [], water: [], waterLines: [], green: [],
    places: [{ n: 'غزة', k: 'city', r: 6, lat: 31.516, lng: 34.458 }],
    areas: [],
  }), 'utf8');
  const prevEnv = process.env.OFFLINE_TILES_FILE;
  const prevVecEnv = process.env.OFFLINE_VECTORMAP_FILE;
  const prevRes = process.resourcesPath;
  delete process.env.OFFLINE_TILES_FILE;
  delete process.env.OFFLINE_VECTORMAP_FILE;
  process.resourcesPath = resDir;
  tilesMod._reset();
  require('../server/vectormap.js')._reset();
  const b = await startBackend({ appDir: root, dataFile, port: 47965 });
  try {
    const pw = await b.resetPassword();
    const { cookie } = await login(b, pw);
    const info = await (await fetch(`${b.url}api/tiles/info`, { headers: { cookie } })).json();
    assert.equal(info.available, true);
    assert.equal(info.name, 'Desktop Pack');
    const tileRes = await fetch(`${b.url}api/tiles/11/1219/835.webp`, { headers: { cookie } });
    assert.equal(tileRes.status, 200);
    assert.deepEqual(Buffer.from(await tileRes.arrayBuffer()), sampleBlob);

    // /api/vectormap is served from extraResources too.
    const vmInfo = await (await fetch(`${b.url}api/vectormap/info`, { headers: { cookie } })).json();
    assert.equal(vmInfo.available, true);
    assert.equal(vmInfo.version, 2);
    const vm = await (await fetch(`${b.url}api/vectormap`, { headers: { cookie } })).json();
    assert.equal(vm.v, 2);
    assert.equal(vm.places[0].n, 'غزة');
  } finally {
    await b.stop();
    tilesMod._reset();
    require('../server/vectormap.js')._reset();
    if (prevEnv === undefined) delete process.env.OFFLINE_TILES_FILE; else process.env.OFFLINE_TILES_FILE = prevEnv;
    if (prevVecEnv === undefined) delete process.env.OFFLINE_VECTORMAP_FILE; else process.env.OFFLINE_VECTORMAP_FILE = prevVecEnv;
    process.resourcesPath = prevRes;
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('strict desktop port fails rather than changing the IndexedDB origin', async () => {
  const a = await startBackend({ appDir: root, dataFile, port: 47970 });
  try { await assert.rejects(startBackend({ appDir: root, dataFile, port: 47970, strictPort: true }), { code: 'EADDRINUSE' }); }
  finally { await a.stop(); }
});
