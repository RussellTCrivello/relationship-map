const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient, createSaveQueue } = require('../src/api-client.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const fast = { delay: 5, retryDelays: [10, 20] };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('loadGraph returns revision, nodes and edges', async () => {
  const api = createApiClient(async () => json(200, { revision: 4, nodes: [{ id: 1 }], edges: [] }));
  assert.deepEqual(await api.loadGraph(), { revision: 4, nodes: [{ id: 1 }], edges: [] });
});

test('loadGraph reports "unavailable" when the server has no API (static server / 404)', async () => {
  const notFound = createApiClient(async () => ({ status: 404, ok: false, json: async () => { throw new Error('html'); } }));
  await assert.rejects(notFound.loadGraph(), { code: 'unavailable' });
  const down = createApiClient(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.loadGraph(), { code: 'network' });
});

test('saveGraph sends revision and request ids, and maps 409 / 400 to typed errors', async () => {
  let sent;
  const ok = createApiClient(async (url, init) => { sent = JSON.parse(init.body); return json(200, { ok: true, revision: 8 }); });
  assert.deepEqual(await ok.saveGraph({ nodes: [1], edges: [] }, 7, 'r1', 'r0'), { revision: 8 });
  assert.deepEqual(sent, { nodes: [1], edges: [], baseRevision: 7, requestId: 'r1', ackRequestId: 'r0' });
  const conflict = createApiClient(async () => json(409, { error: 'revision_conflict', revision: 9 }));
  await assert.rejects(conflict.saveGraph({ nodes: [], edges: [] }, 7), { code: 'conflict', revision: 9 });
  const invalid = createApiClient(async () => json(400, { message: 'bad' }));
  await assert.rejects(invalid.saveGraph({ nodes: [], edges: [] }, 7), { code: 'invalid' });
});

test('rapid edits collapse into one save with the latest data', async () => {
  const saved = [];
  const q = createSaveQueue(async p => { saved.push(p); }, null, fast);
  q.schedule('a'); q.schedule('b'); q.schedule('c');
  assert.equal(q.isDirty(), true);
  await wait(40);
  assert.deepEqual(saved, ['c']);
  assert.equal(q.isDirty(), false);
});

test('an edit made while a save is in flight is saved afterwards, never lost', async () => {
  const saved = []; let release;
  const q = createSaveQueue(p => new Promise(res => { saved.push(p); if (p === 'a') release = res; else res(); }), null, fast);
  q.schedule('a'); await wait(15);
  q.schedule('b'); await wait(15);
  assert.deepEqual(saved, ['a']);           // still waiting on the first request
  release(); await wait(30);
  assert.deepEqual(saved, ['a', 'b']);
  assert.equal(q.isDirty(), false);
});

test('failed saves are retried with the same request id, then succeed', async () => {
  const calls = []; let n = 0; const states = [];
  const q = createSaveQueue(async (p, id, ack) => { calls.push({ p, id, ack }); if (++n < 3) throw Object.assign(new Error('down'), { code: 'network' }); }, s => states.push(s), fast);
  q.schedule('x'); await wait(120);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(c => c.id)).size, 1, 'retries reuse the request id');
  assert.equal(calls[0].ack, null);
  assert.equal(states.filter(s => s === 'error').length, 2);
  assert.equal(states.at(-1), 'saved');
  assert.equal(q.isDirty(), false);
});

test('a newer edit after a failed attempt names the unknown attempt so the server can recognise it', async () => {
  const calls = []; let n = 0;
  const q = createSaveQueue(async (p, id, ack) => { calls.push({ p, id, ack }); if (++n === 1) throw Object.assign(new Error('lost'), { code: 'network' }); }, null, { delay: 5, retryDelays: [30] });
  q.schedule('a'); await wait(15);          // attempt 1 fails, retry armed for ~30ms
  q.schedule('b'); await wait(80);          // newer payload replaces it
  assert.equal(calls.length, 2);
  assert.equal(calls[1].p, 'b');
  assert.notEqual(calls[1].id, calls[0].id);
  assert.equal(calls[1].ack, calls[0].id);
});

test('a revision conflict stops all further writes', async () => {
  const calls = []; const states = [];
  const q = createSaveQueue(async p => { calls.push(p); throw Object.assign(new Error('stale'), { code: 'conflict' }); }, s => states.push(s), fast);
  q.schedule('a'); await wait(30);
  q.schedule('b'); await wait(30);
  assert.deepEqual(calls, ['a']);
  assert.equal(q.isStopped(), true);
  assert.equal(states.at(-1), 'conflict');
});

test('layout: loadLayout returns null when nothing is saved, saveLayout sends the payload and maps 400', async () => {
  const empty = createApiClient(async () => json(200, { empty: true }));
  assert.equal(await empty.loadLayout(), null);
  const have = createApiClient(async () => json(200, { version: 1, layout: 'grouped', positions: { 1: { x: 1, y: 2 } }, scale: 1 }));
  assert.deepEqual((await have.loadLayout()).positions, { 1: { x: 1, y: 2 } });
  const noApi = createApiClient(async () => ({ status: 404, ok: false, json: async () => { throw new Error('html'); } }));
  await assert.rejects(noApi.loadLayout(), { code: 'unavailable' });
  let sent, method;
  const ok = createApiClient(async (url, init) => { sent = JSON.parse(init.body); method = init.method; return json(200, { ok: true, savedAt: 't' }); });
  await ok.saveLayout({ positions: { 1: { x: 1, y: 2 } } });
  assert.equal(method, 'PUT'); assert.deepEqual(sent, { positions: { 1: { x: 1, y: 2 } } });
  await assert.rejects(createApiClient(async () => json(400, { message: 'bad' })).saveLayout({ positions: {} }), { code: 'invalid' });
});

test('graph client preserves zones across load and save while accepting old responses', async () => {
  const zones = [{ id: 'z', name: 'منطقة', shape: 'circle', color: '#d4ff3f', center: { lat: 0, lng: 0 }, radius: 10 }];
  let sent;
  const api = createApiClient(async (_url, init) => init?.method === 'PUT' ? (sent = JSON.parse(init.body), json(200, { revision: 3 })) : json(200, { nodes: [], edges: [], zones, revision: 2 }));
  assert.deepEqual((await api.loadGraph()).zones, zones);
  await api.saveGraph({ nodes: [], edges: [], zones }, 2);
  assert.deepEqual(sent.zones, zones);
});
