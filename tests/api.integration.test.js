// API integration tests against a real PostgreSQL database.
//
// These REPLACE all data in the target database, so they only run when TEST_DATABASE_URL is set,
// and they never fall back to DATABASE_URL. Point it at a throwaway database, e.g.:
//   TEST_DATABASE_URL=postgres://relationship_map:pw@127.0.0.1:5432/relationship_map_test npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// TEST_DB_ENGINE=file runs the same tests against the desktop app's single-file storage (no database needed).
const useFile = process.env.TEST_DB_ENGINE === 'file';
const url = process.env.TEST_DATABASE_URL;
const skip = (url || useFile) ? false : 'set TEST_DATABASE_URL (a throwaway database) to run the database tests';

let server, base, pool, cookie = '';
// Every API call is made as the signed-in administrator, exactly like the browser does.
const afetch = (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
const ADMIN_PASSWORD = 'test-password-123';

test.before(async () => {
  if (skip) return;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'admin';
  if (useFile) {
    process.env.DB_ENGINE = 'file';
    process.env.DATA_FILE = path.join(require('node:os').tmpdir(), `rm-test-${process.pid}`, 'data.json');
  } else {
    process.env.DATABASE_URL = url;
    execFileSync(process.execPath, [path.join(__dirname, '../server/migrate.js')], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  }
  ({ pool } = require('../server/db'));
  const { app } = require('../server/app.js');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query('TRUNCATE admin_account, admin_sessions');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (skip) return;
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

test.beforeEach(async () => {
  if (skip) return;
  await pool.query('TRUNCATE entities, relationships CASCADE');
  await pool.query('UPDATE graph_meta SET revision=0, last_request_id=NULL WHERE id=1');
  await pool.query('UPDATE graph_meta SET zones=$1::jsonb WHERE id=1', ['[]']);
  await pool.query('TRUNCATE layout_state');
});

const put = body => afetch(`${base}/api/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async () => (await afetch(`${base}/api/graph`)).json();
const graph = (labels = ['A', 'B']) => ({
  nodes: labels.map((label, i) => ({ id: i + 1, label, schema: 'Person' })),
  edges: labels.length > 1 ? [{ id: 10, source: 1, target: 2, type: 'Friend' }] : [],
});

test('empty database returns an empty graph at revision 0', { skip }, async () => {
  assert.deepEqual(await get(), { revision: 0, nodes: [], edges: [], zones: [] });
});

test('a saved graph round-trips with order, numeric ids and extra properties intact', { skip }, async () => {
  const g = { nodes: [{ id: 30, label: 'Zed', schema: 'Person', summary: 'x', extra: { a: 1 } }, { id: 5, label: 'Amy', schema: 'Org' }], edges: [{ id: 2, source: 30, target: 5, type: 'Works', note: 'n' }] };
  const res = await put({ ...g, baseRevision: 0 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revision, 1);
  const back = await get();
  assert.equal(back.revision, 1);
  assert.deepEqual(back.nodes, g.nodes);   // order preserved (30 before 5), ids stay numbers
  assert.deepEqual(back.edges, g.edges);
});

test('saving replaces the previous graph and bumps the revision each time', { skip }, async () => {
  await put({ ...graph(), baseRevision: 0 });
  const r = await put({ ...graph(['Only']), baseRevision: 1 });
  assert.equal((await r.json()).revision, 2);
  const back = await get();
  assert.equal(back.nodes.length, 1);
  assert.equal(back.edges.length, 0);
});

test('a stale revision is rejected with 409 and leaves the data untouched', { skip }, async () => {
  await put({ ...graph(), baseRevision: 0 });
  const stale = await put({ ...graph(['Intruder']), baseRevision: 0 });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error, 'revision_conflict');
  assert.equal(body.revision, 1);
  assert.deepEqual((await get()).nodes.map(n => n.label), ['A', 'B']);
});

test('retrying a save that already succeeded is accepted, not a conflict', { skip }, async () => {
  const first = await put({ ...graph(), baseRevision: 0, requestId: 'req-1' });
  assert.equal(first.status, 200);
  const retry = await put({ ...graph(), baseRevision: 0, requestId: 'req-1' });
  assert.equal(retry.status, 200);
  const body = await retry.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.revision, 1);
});

test('a later save may name an earlier attempt of the same client whose result was lost', { skip }, async () => {
  await put({ ...graph(['A', 'B']), baseRevision: 0, requestId: 'req-1' });         // applied, response "lost"
  const next = await put({ ...graph(['C', 'D']), baseRevision: 0, requestId: 'req-2', ackRequestId: 'req-1' });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).revision, 2);
  // an unrelated writer naming a different attempt is still a conflict
  const other = await put({ ...graph(['X', 'Y']), baseRevision: 0, requestId: 'req-3', ackRequestId: 'someone-else' });
  assert.equal(other.status, 409);
  assert.deepEqual((await get()).nodes.map(n => n.label), ['C', 'D']);
});

test('invalid graphs are rejected and nothing is written', { skip }, async () => {
  const cases = {
    'dangling relationship': { nodes: [{ id: 1, label: 'A' }], edges: [{ id: 1, source: 1, target: 9 }] },
    'self relationship': { nodes: [{ id: 1, label: 'A' }], edges: [{ id: 1, source: 1, target: 1 }] },
    'duplicate entity ids': { nodes: [{ id: 1, label: 'A' }, { id: '1', label: 'B' }], edges: [] },
    'entity without a name': { nodes: [{ id: 1 }], edges: [] },
    'unknown top-level key': { nodes: [], edges: [], hack: true },
  };
  await put({ ...graph(), baseRevision: 0 });
  for (const [name, body] of Object.entries(cases)) {
    const res = await put(body);
    assert.equal(res.status, 400, name);
  }
  const back = await get();
  assert.equal(back.revision, 1);
  assert.equal(back.nodes.length, 2);
});

test('malformed JSON gets a 400, not a 500', { skip }, async () => {
  const res = await afetch(`${base}/api/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
});

test('only browser files are served; server code, config and backups are not', { skip }, async () => {
  for (const p of ['/', '/index.html', '/src/app.js', '/assets/css/app.css', '/data/network.json']) {
    assert.equal((await afetch(base + p)).status, 200, p);
  }
  for (const p of ['/server/app.js', '/server/db.js', '/package.json', '/.env', '/.env.example', '/compose.yaml', '/db/migrations/001_initial.sql', '/backups/.gitkeep', '/scripts/backup.sh']) {
    assert.equal((await afetch(base + p)).status, 404, p);
  }
});

const putLayout = body => afetch(`${base}/api/layout`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getLayout = async () => (await afetch(`${base}/api/layout`)).json();

test('layout: nothing saved yet reports empty', { skip }, async () => {
  assert.deepEqual(await getLayout(), { empty: true });
});

test('layout: positions and view round-trip, and positions of deleted entities are dropped', { skip }, async () => {
  await put({ ...graph(), baseRevision: 0 });          // entities "1" and "2"
  const res = await putLayout({ layout: 'concentric', positions: { 1: { x: 10.5, y: -20 }, 2: { x: 300, y: 400 }, 99: { x: 1, y: 1 } }, scale: 1.25, tx: 40, ty: -15 });
  assert.equal(res.status, 200);
  const back = await getLayout();
  assert.equal(back.version, 1);
  assert.equal(back.layout, 'concentric');
  assert.deepEqual(back.positions, { 1: { x: 10.5, y: -20 }, 2: { x: 300, y: 400 } });   // "99" is not an entity
  assert.equal(back.scale, 1.25); assert.equal(back.tx, 40); assert.equal(back.ty, -15);
  // last write wins, and saving a layout never touches the graph revision
  await putLayout({ positions: { 1: { x: 0, y: 0 } } });
  assert.deepEqual((await getLayout()).positions, { 1: { x: 0, y: 0 } });
  assert.equal((await get()).revision, 1);
});

test('layout: invalid payloads are rejected and the saved layout is kept', { skip }, async () => {
  await put({ ...graph(), baseRevision: 0 });
  await putLayout({ positions: { 1: { x: 5, y: 5 } } });
  for (const bad of [
    { positions: { 1: { x: 'a', y: 1 } } }, { positions: { 1: { x: 1 } } }, { positions: { 1: { x: 1e9, y: 1 } } },
    { positions: {}, scale: 100 }, { positions: {}, layout: 'spiral' }, { positions: {}, extra: true }, { nope: 1 },
  ]) assert.equal((await putLayout(bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await getLayout()).positions, { 1: { x: 5, y: 5 } });
});

// ---- Authentication ----
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('data routes require a session; health and the login screen stay public', { skip }, async () => {
  for (const p of ['/api/graph', '/api/layout', '/api/export', '/api/entities', '/data/network.json']) {
    assert.equal((await fetch(`${base}${p}`)).status, 401, p);
  }
  assert.equal((await fetch(`${base}/api/graph`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await afetch(`${base}/data/network.json`)).status, 200);
});

test('login: wrong credentials are refused, the cookie is HttpOnly + SameSite=Strict', { skip }, async () => {
  assert.equal((await post('/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await post('/api/auth/login', { username: 'someone', password: ADMIN_PASSWORD })).status, 401);
  const ok = await post('/api/auth/login', { username: 'Admin', password: ADMIN_PASSWORD });
  assert.equal(ok.status, 200);
  const c = ok.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: c.split(';')[0] } });
  assert.deepEqual(await me.json(), { authenticated: true, username: 'admin' });
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
});

test('the password is stored hashed, never in clear text', { skip }, async () => {
  const row = (await pool.query('SELECT password_hash FROM admin_account WHERE id=1')).rows[0];
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(ADMIN_PASSWORD));
});

test('logout ends the session', { skip }, async () => {
  const login = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
  const ck = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/graph`, { headers: { cookie: ck } })).status, 200);
  assert.equal((await post('/api/auth/logout', {}, { cookie: ck })).status, 200);
  assert.equal((await fetch(`${base}/api/graph`, { headers: { cookie: ck } })).status, 401);
});

test('change password: validates, signs out other sessions, new password works', { skip }, async () => {
  const other = (await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).headers.get('set-cookie').split(';')[0];
  const change = body => post('/api/auth/password', body, { cookie });
  assert.equal((await post('/api/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'another-pass-1' })).status, 401, 'needs a session');
  assert.equal((await change({ currentPassword: 'wrong', newPassword: 'another-pass-1' })).status, 403);
  assert.equal((await change({ currentPassword: ADMIN_PASSWORD, newPassword: 'short' })).status, 400);
  assert.equal((await change({ currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD })).status, 400);
  const ok = await change({ currentPassword: ADMIN_PASSWORD, newPassword: 'another-pass-1' });
  assert.equal(ok.status, 200);
  const fresh = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/graph`, { headers: { cookie: other } })).status, 401, 'other sessions are signed out');
  assert.equal((await fetch(`${base}/api/graph`, { headers: { cookie: fresh } })).status, 200, 'this session continues');
  assert.equal((await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).status, 401, 'old password no longer works');
  assert.equal((await post('/api/auth/login', { username: 'admin', password: 'another-pass-1' })).status, 200);
  cookie = fresh;
  // restore for any later test
  assert.equal((await post('/api/auth/password', { currentPassword: 'another-pass-1', newPassword: ADMIN_PASSWORD }, { cookie })).status, 200);
  cookie = (await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).headers.get('set-cookie').split(';')[0];
});

test('repeated failed logins are rate limited (429), even with the right password afterwards', { skip }, async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await post('/api/auth/login', { username: 'admin', password: 'wrong-' + i });
  assert.equal(last.status, 429);
  assert.equal((await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).status, 429);
});

test('zones round-trip and legacy graph saves do not erase them', { skip }, async () => {
  const zone = { id: 'z1', name: 'منطقة اختبار', color: '#d4ff3f', note: 'ملاحظة', shape: 'circle', center: { lat: 31.5, lng: 34.4 }, radius: 100, photos: [] };
  const first = await put({ ...graph(), zones: [zone], baseRevision: 0 });
  assert.equal(first.status, 200); assert.deepEqual((await get()).zones, [zone]);
  const legacy = await put({ ...graph(['Only']), baseRevision: 1 });
  assert.equal(legacy.status, 200); assert.deepEqual((await get()).zones, [zone]);
  const bad = await put({ ...graph(), zones: [{ ...zone, center: { lat: 999, lng: 0 } }], baseRevision: 2 });
  assert.equal(bad.status, 400); assert.deepEqual((await get()).zones, [zone]);
  const remove = await put({ ...graph(), zones: [], baseRevision: 2 });
  assert.equal(remove.status, 200); assert.deepEqual((await get()).zones, []);
});

test('optional profiles round-trip without altering nodes with no profile', { skip }, async () => {
  const profile = { personal: { birthDate: '1982-07', idNumber: 'private-id', phone: 'private-phone' }, maritalStatus: 'married', role: { title: 'منسق', group: 'فريق' }, family: [{ id: 'f1', relation: 'أخت', name: 'أمل', entityId: '2', phone: 'private-family-phone' }], health: { status: 'مستقرة', conditions: ['حالة'] } };
  const body = { nodes: [{ id: 1, label: 'أ', schema: 'Person', profile }, { id: 2, label: 'ب', schema: 'Organization' }], edges: [] };
  assert.equal((await put({ ...body, baseRevision: 0 })).status, 200);
  const back = await get();
  assert.deepEqual(back.nodes, body.nodes);
  assert.equal(Object.hasOwn(back.nodes[1], 'profile'), false);
});

test('profile export excludes sensitive values unless explicitly requested', { skip }, async () => {
  const data={nodes:[{id:1,label:'Test',profile:{personal:{idNumber:'SECRET-ID',phone:'SECRET-PHONE',email:'SECRET-EMAIL'},role:{title:'Manager'},health:{notes:'SECRET-HEALTH'},family:[{id:'f1',name:'Relative',phone:'SECRET-FAMILY'}]}}],edges:[]};
  assert.equal((await put({...data,baseRevision:0})).status,200);
  const safe=await (await afetch(base+'/api/export')).json(), full=await (await afetch(base+'/api/export?includeSensitive=true')).json();
  assert.equal(JSON.stringify(safe).includes('SECRET-'),false);assert.equal(safe.nodes[0].profile.role.title,'Manager');
  assert.deepEqual(full.nodes[0].profile,data.nodes[0].profile);
});
