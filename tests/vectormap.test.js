'use strict';
// Request 1B.3 — GET /api/vectormap and GET /api/vectormap/info
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../src/geo.js');
const vectormapMod = require('../server/vectormap.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-vectormap-test-'));
const dataFile = path.join(tmpDir, 'data.json');
const vmPath = path.join(tmpDir, 'gaza.vectormap.json');
const ADMIN_PASSWORD = 'vectormap-test-password-123';

let server, base, cookie = '';
const afetch = (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });

const sampleMap = {
  v: 2,
  bbox: { ...G.GAZA_BOUNDS },
  created: '2025-11-01T00:00:00.000Z',
  source: '© OpenStreetMap contributors',
  detail: 'medium',
  roads: [{ k: 'major', n: 'شارع صلاح الدين', p: G.pack([[31.3, 34.3], [31.4, 34.45]]) }],
  rail: [], water: [], waterLines: [], green: [],
  places: [{ n: 'غزة', ne: 'Gaza', t: 'city', k: 'city', r: 6, lat: 31.5, lng: 34.46 }],
  areas: [{ n: 'مستشفى الشفاء', ne: 'Al-Shifa Hospital', k: 'landmark', r: 2, lat: 31.52, lng: 34.45 }],
};

test.before(async () => {
  fs.writeFileSync(vmPath, JSON.stringify(sampleMap), 'utf8');

  process.env.DB_ENGINE = 'file';
  process.env.DATA_FILE = dataFile;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.OFFLINE_VECTORMAP_FILE = vmPath;

  const { _reset } = require('../server/file-pool.js');
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
});

test.after(async () => {
  vectormapMod._reset();
  if (server) await new Promise(resolve => server.close(resolve));
  delete process.env.OFFLINE_VECTORMAP_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('vectormap routes require authentication like every other /api route', async () => {
  assert.equal((await fetch(`${base}/api/vectormap/info`)).status, 401);
  assert.equal((await fetch(`${base}/api/vectormap`)).status, 401);
});

test('GET /api/vectormap/info reports version hash, bounds and stats', async () => {
  const r = await afetch(`${base}/api/vectormap/info`);
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.available, true);
  assert.equal(info.version, 2);
  assert.match(info.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual(info.bbox, { ...G.GAZA_BOUNDS });
  assert.ok(info.size > 0);
  assert.ok(info.gzipSize > 0 && info.gzipSize < info.size);
  assert.equal(info.stats.labels, 2);
  assert.equal(info.stats.roads, 1);
});

test('GET /api/vectormap serves the basemap gzipped with an ETag and honours If-None-Match', async () => {
  const gz = await afetch(`${base}/api/vectormap`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  const etag = gz.headers.get('etag');
  assert.match(etag, /^"vm-[0-9a-f]{16}"$/);
  assert.match(gz.headers.get('x-vectormap-hash'), /^[0-9a-f]{16}$/);
  // fetch() transparently decompresses; parse the payload to prove the gzip stream was valid.
  const body = Buffer.from(await gz.arrayBuffer());
  const parsed = JSON.parse(body.toString('utf8'));
  assert.equal(parsed.v, 2);
  assert.deepEqual(parsed.bbox, { ...G.GAZA_BOUNDS });
  assert.doesNotThrow(() => G.validateBasemap(parsed));

  // Plain request without gzip support still returns valid JSON.
  const plain = await afetch(`${base}/api/vectormap`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await plain.json()).v, 2);

  const cached = await afetch(`${base}/api/vectormap`, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
});

test('the info hash changes when the served file changes (used by the client to update)', async () => {
  const before = await (await afetch(`${base}/api/vectormap/info`)).json();
  const changed = JSON.parse(JSON.stringify(sampleMap));
  changed.places.push({ n: 'خان يونس', k: 'city', r: 5, lat: 31.35, lng: 34.3 });
  // Ensure a newer mtime so the cache invalidates.
  fs.writeFileSync(vmPath, JSON.stringify(changed), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(vmPath, future, future);
  vectormapMod._reset();

  const after = await (await afetch(`${base}/api/vectormap/info`)).json();
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.stats.labels, 3);
});

test('a missing or broken bundled file reports available:false and 404s without crashing', async () => {
  process.env.OFFLINE_VECTORMAP_FILE = path.join(tmpDir, 'nope.json');
  vectormapMod._reset();
  const info = await (await afetch(`${base}/api/vectormap/info`)).json();
  assert.equal(info.available, false);
  assert.equal(info.version, 0);
  assert.deepEqual(info.bbox, { ...G.GAZA_BOUNDS }, 'the client still gets the built-in bounds for its fallback download');
  const r = await afetch(`${base}/api/vectormap`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'vectormap_not_found');

  // Malformed JSON is treated as missing, never as a 500.
  const brokenPath = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(brokenPath, '{"v":2,', 'utf8');
  process.env.OFFLINE_VECTORMAP_FILE = brokenPath;
  vectormapMod._reset();
  assert.equal((await afetch(`${base}/api/vectormap`)).status, 404);
  assert.equal((await (await afetch(`${base}/api/vectormap/info`)).json()).available, false);

  process.env.OFFLINE_VECTORMAP_FILE = vmPath;
  vectormapMod._reset();
});

test('the bundled Gaza vector map file is a valid v2 basemap (skipped when not generated)', async () => {
  const file = path.join(__dirname, '..', 'offline_map', 'gaza.vectormap.json');
  if (!fs.existsSync(file)) return; // generated by `npm run build:vectormap`
  const bm = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.doesNotThrow(() => G.validateBasemap(bm));
  assert.equal(bm.v, 2);
  assert.ok(bm.areas.length > 100, 'area labels collected');
  assert.ok(bm.places.length > 20, 'place labels collected');
  const classes = new Set([...bm.places, ...bm.areas].map(x => x.k));
  for (const k of ['admin', 'city', 'hood', 'landmark', 'green', 'water']) {
    assert.ok(classes.has(k), `class ${k} present`);
  }
  assert.ok(bm.bbox.n > bm.bbox.s && bm.bbox.e > bm.bbox.w);
});
