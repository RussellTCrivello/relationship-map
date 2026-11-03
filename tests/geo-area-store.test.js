'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geo');
const Areas = require('../src/geo-area-store');
const built = G.builtinGazaArea();
const raw = bbox => G.parseOverpass({ elements: [] }, bbox, { detail: 'basic' });
const custom = id => { const bbox = G.bboxAround(40, -74, 10); return { id, builtin: false, name: 'نيويورك', center: { lat: 40, lng: -74 }, bbox, sideKm: 10, areaKm2: G.bboxAreaKm2(bbox), detail: 'basic' }; };
function memory(initial = {}) {
  const data = new Map(Object.entries(initial)); let fail = false;
  return { data, get: async key => data.get(key), batch: async (sets, deletes) => { if (fail) throw new Error('quota'); const next = new Map(data); for (const [k, v] of sets) next.set(k, structuredClone(v)); for (const k of deletes) next.delete(k); data.clear(); for (const [k, v] of next) data.set(k, v); }, setFail: v => { fail = v; } };
}
test('migrates legacy builtin area and map atomically without deleting old data', async () => {
  const base = raw(built.bbox), db = memory({ area: built, basemap: base }); const store = Areas.createStore(db, G);
  const loaded = await store.load(built);
  assert.equal(loaded.activeId, 'gaza'); assert.deepEqual(loaded.base, base); assert.equal(db.data.get('area:gaza').builtin, true);
  assert.deepEqual(db.data.get('basemap'), base); assert.deepEqual(db.data.get('basemap:gaza'), base);
});
test('migrates custom area and preserves mismatched legacy map as a separate recovered area', async () => {
  const area = custom('unused'), base = raw(G.bboxAround(33, 35, 10)); delete area.id;
  const db = memory({ area, basemap: base }), store = Areas.createStore(db, G); const loaded = await store.load(built);
  assert.equal(loaded.activeId, 'legacy'); assert.equal(loaded.base, null);
  assert.equal(loaded.areas.length, 3); assert.deepEqual(db.data.get('basemap:recovered'), base); assert.deepEqual(db.data.get('basemap'), base);
});
test('switches isolated maps, protects builtin, and removes only inactive custom areas', async () => {
  const db = memory(), store = Areas.createStore(db, G); await store.load(built);
  const a = custom('a'), b = { ...custom('b'), name: 'نسخة' }, base = raw(a.bbox);
  await store.putArea({ ...built, id: 'gaza', builtin: true }, raw(built.bbox));
  await store.putArea(a, base); await store.putArea(b, null);
  assert.equal((await store.switchArea('b')).base, null); assert.equal(db.data.has('basemap'), false);
  assert.deepEqual((await store.switchArea('a')).base, base); assert.deepEqual(db.data.get('basemap'), base);
  await assert.rejects(store.removeArea('gaza'), /لا يمكن/); await assert.rejects(store.removeArea('a'), /انتقل/);
  await store.removeArea('b'); assert.equal(db.data.has('area:b'), false); assert.ok(db.data.has('area:gaza'));
});
test('rejects wrong map bounds, unsafe IDs and storage failure without partial writes', async () => {
  const db = memory(), store = Areas.createStore(db, G); await store.load(built); const before = structuredClone([...db.data]);
  await assert.rejects(store.putArea(custom('a'), raw(built.bbox)), /لا تطابق/);
  await assert.rejects(store.putArea(custom('../bad'), null), /غير صالحة/);
  db.setFail(true); await assert.rejects(store.putArea(custom('a'), raw(custom('a').bbox)), /quota/);
  assert.deepEqual([...db.data], before);
});
test('serializes concurrent area updates and prevents late builtin installs from stealing selection', async () => {
  const db = memory(), store = Areas.createStore(db, G); await store.load(built);
  const a = custom('a'), b = custom('b');
  await Promise.all([store.putArea(a, raw(a.bbox)), store.putArea(b, raw(b.bbox))]);
  assert.deepEqual(db.data.get('areas:index'), ['gaza', 'a', 'b']); assert.equal(db.data.get('areas:active'), 'b');
  const result = await store.putArea({ ...built, id: 'gaza', builtin: true }, raw(built.bbox), true, 'gaza');
  assert.equal(result.activated, false); assert.equal(db.data.get('areas:active'), 'b'); assert.ok(db.data.has('basemap:gaza'));
});
test('multi-area backup imports copies atomically without overwriting the builtin or switching the active area', async () => {
  const db = memory(), store = Areas.createStore(db, G); await store.load(built);
  const b = { ...built, id: 'gaza', builtin: true }; await store.putArea(b, raw(b.bbox));
  const a = custom('a'); await store.putArea(a, raw(a.bbox));
  const backup = await store.backup(), beforeBuiltin = structuredClone(db.data.get('basemap:gaza'));
  assert.deepEqual(store.inspectBackup(backup), { count: 2, maps: 2 });
  assert.equal(await store.importBackup(backup), 2); assert.equal(db.data.get('areas:index').length, 4); assert.equal(db.data.get('areas:active'), 'a');
  assert.deepEqual(db.data.get('basemap:gaza'), beforeBuiltin);
  const copied = db.data.get('areas:index').slice(2); assert.equal(db.data.get(`area:${copied[0]}`).builtin, false);
  const before = structuredClone([...db.data]); db.setFail(true); await assert.rejects(store.importBackup(backup), /quota/); assert.deepEqual([...db.data], before);
});
test('rejects corrupt, duplicate, mismatched or untrusted builtin area backup data before writing', async () => {
  const db = memory(), store = Areas.createStore(db, G); await store.load(built);
  const backup = await store.backup(), before = structuredClone([...db.data]);
  const dup = structuredClone(backup); dup.areas.push(dup.areas[0]); assert.throws(() => store.inspectBackup(dup), /مكرر/);
  const broken = structuredClone(backup); broken.areas[0].basemap = raw(custom('a').bbox); assert.throws(() => store.inspectBackup(broken), /لا تطابق/);
  const fake = structuredClone(backup); fake.areas[0].area.id = 'evil'; assert.throws(() => store.inspectBackup(fake), /غير صالحة/);
  assert.deepEqual([...db.data], before);
});
