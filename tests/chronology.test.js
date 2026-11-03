const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/chronology.js');
const { validateDataset } = require('../src/data-validation.js');

const nextId = r => r.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
const base = () => ({
  nodes: [
    { id: 1, label: 'أحمد', schema: 'Person' }, { id: 2, label: 'شركة النور', schema: 'Organization' },
    { id: 3, label: 'ميناء الشمال', schema: 'Address' }, { id: 4, label: 'سارة', schema: 'Person' },
  ],
  edges: [],
});
const draft = (o = {}) => ({ title: 'اجتماع', type: 'meeting', date: '2026-03-14', datePrecision: 'exact', time: '10:30', location: 'مكتب', description: 'وصف', notes: '', sources: [], attachments: [], verification: 'verified', participants: [{ id: 1, role: 'حاضر' }], ...o });

test('dates: parsing, ranges, formatting, sort keys', () => {
  assert.equal(C.parseDate('2026-02-30'), null);
  assert.equal(C.parseDate('2026-13'), null);
  assert.equal(C.parseDate('2026').grain, 'year');
  assert.deepEqual(C.dateRange({ date: '2024-02', datePrecision: 'approx' }), ['2024-02-01', '2024-02-29']);
  assert.deepEqual(C.dateRange({ date: '2026', datePrecision: 'approx' }), ['2026-01-01', '2026-12-31']);
  assert.equal(C.dateRange({ date: '2026-01-01', datePrecision: 'unknown' }), null);
  assert.equal(C.formatDate({ date: '2026-03-14', datePrecision: 'exact', time: '09:05' }), '14 مارس 2026 · 09:05');
  assert.equal(C.formatDate({ date: '2026-03', datePrecision: 'approx' }), 'حوالي مارس 2026');
  assert.equal(C.formatDate({ date: '', datePrecision: 'unknown' }), 'تاريخ غير معروف');
});

test('legacy event nodes get sensible defaults', () => {
  const ev = C.normalizeEvent({ id: 195, label: 'حملة', schema: 'Event', date: '2026-03-14', summary: 'x' });
  assert.equal(ev.datePrecision, 'exact'); assert.equal(ev.verification, 'unverified'); assert.equal(ev.type, 'other');
  assert.equal(C.normalizeEvent({ id: 1, label: 'بلا تاريخ', schema: 'Event' }).datePrecision, 'unknown');
});

test('create an event once and link several entities; edit participants; delete', () => {
  const data = base();
  assert.deepEqual(C.validateDraft(draft({ participants: [{ id: 1 }, { id: 2 }, { id: 3 }] }), { requireParticipants: true }), []);
  const { node, added } = C.applyDraft(data, draft({ participants: [{ id: 1, role: 'حاضر' }, { id: 2, role: 'منظِّم' }, { id: 3, role: 'مكان الحدث' }] }), nextId);
  assert.equal(added, 3);
  assert.equal(data.nodes.filter(C.isEventNode).length, 1, 'one event entity only');
  assert.doesNotThrow(() => validateDataset(data));
  let events = C.collectEvents(data.nodes, data.edges);
  assert.deepEqual(events[0].participants.map(p => p.id).sort(), ['1', '2', '3']);
  assert.equal(C.eventsOfEntity(events, 3).length, 1);
  // edit: drop 2, add 4, change a role, new title
  const d = C.draftFromEvent(events[0]);
  d.title = 'اجتماع معدّل'; d.participants = [{ id: '1', role: 'رئيس' }, { id: '3', role: 'مكان الحدث' }, { id: '4', role: '' }];
  const r = C.applyDraft(data, d, nextId);
  assert.equal(r.node.id, node.id); assert.equal(r.added, 1); assert.equal(r.removed, 1);
  events = C.collectEvents(data.nodes, data.edges);
  assert.equal(events[0].title, 'اجتماع معدّل');
  assert.equal(events[0].participants.find(p => p.id === '1').role, 'رئيس');
  assert.equal(data.edges.length, 3);
  assert.doesNotThrow(() => validateDataset(data));
  // delete removes the event and every link, but not the people
  assert.equal(C.removeEvent(data, node.id), 3);
  assert.equal(data.nodes.length, 4); assert.equal(data.edges.length, 0);
});

test('relocation keeps from/to, other types keep a single location; unknown date drops date and time', () => {
  const data = base();
  const a = C.applyDraft(data, draft({ type: 'relocation', location: 'تجاهل', fromLocation: 'غزة', toLocation: 'رفح' }), nextId).node;
  assert.equal(a.location, undefined); assert.equal(a.fromLocation, 'غزة');
  assert.equal(C.placeText(C.normalizeEvent(a)), 'من غزة إلى رفح');
  const b = C.applyDraft(data, draft({ title: 'ب', type: 'مؤتمر صحفي', fromLocation: 'x', datePrecision: 'unknown', date: '2026-01-01', time: '' }), nextId).node;
  assert.equal(b.fromLocation, undefined); assert.equal(b.date, undefined); assert.equal(b.datePrecision, 'unknown');
  assert.deepEqual(C.customTypes(C.collectEvents(data.nodes, data.edges)), ['مؤتمر صحفي']);
  assert.equal(C.typeLabel('مؤتمر صحفي'), 'مؤتمر صحفي');
});

test('validation rules', () => {
  const has = (d, text) => C.validateDraft(d).some(e => e.includes(text));
  assert.ok(has(draft({ title: ' ' }), 'عنوان'));
  assert.ok(has(draft({ date: '2026-3-1' }), 'صيغة التاريخ'));
  assert.ok(has(draft({ date: '2026-03' }), 'يومًا كاملًا'));
  assert.equal(C.validateDraft(draft({ date: '2026-03', datePrecision: 'approx', time: '' })).length, 0);
  assert.ok(has(draft({ time: '25:00' }), 'الوقت'));
  assert.ok(has(draft({ datePrecision: 'unknown', time: '10:00' }), 'وقت'));
  assert.ok(C.validateDraft(draft({ participants: [] }), { requireParticipants: true }).some(e => e.includes('مشاركًا')));
  assert.equal(C.validateDraft(draft({ participants: [] })).length, 0, 'personal events need no participants');
  assert.ok(has(draft({ participants: [{ id: 1 }, { id: '1' }] }), 'مكرر'));
  assert.ok(has(draft({ sources: [{ url: 'javascript:alert(1)' }] }), 'رابط المصدر'));
  assert.ok(has(draft({ attachments: [{ name: 'big', data: 'data:x', size: 9e6 }] }), 'أكبر'));
});

test('sorting puts undated events last; filters by text, type, date range, place, participant, entity', () => {
  const data = base();
  const add = o => C.applyDraft(data, draft(o), nextId);
  add({ title: 'سفر إلى القاهرة', type: 'travel', date: '2026-05-02', time: '08:00', fromLocation: 'غزة', toLocation: 'القاهرة', participants: [{ id: 1 }] });
  add({ title: 'وفاة', type: 'death', date: '2025', datePrecision: 'approx', time: '', participants: [{ id: 4 }] });
  add({ title: 'حدث مجهول', datePrecision: 'unknown', date: '', time: '', participants: [{ id: 1 }, { id: 3 }] });
  add({ title: 'لقاء في الميناء', date: '2026-03-14', time: '', verification: 'disputed', participants: [{ id: 2 }, { id: 3, role: 'المكان' }] });
  const all = C.collectEvents(data.nodes, data.edges);
  assert.deepEqual(C.sortEvents(all).map(e => e.title), ['وفاة', 'لقاء في الميناء', 'سفر إلى القاهرة', 'حدث مجهول']);
  assert.deepEqual(C.sortEvents(all, 'desc').map(e => e.title), ['سفر إلى القاهرة', 'لقاء في الميناء', 'وفاة', 'حدث مجهول']);
  const t = f => C.filterEvents(all, f).map(e => e.title).sort();
  assert.deepEqual(t({ types: ['travel'] }), ['سفر إلى القاهرة']);
  assert.deepEqual(t({ q: 'القاهره' }), ['سفر إلى القاهرة'], 'Arabic letter variants match');
  assert.deepEqual(t({ from: '2026-01-01', to: '2026-04-01' }), ['لقاء في الميناء']);
  assert.deepEqual(t({ from: '2025-06-01', to: '2025-06-30' }), ['وفاة'], 'approximate year overlaps the range');
  assert.deepEqual(t({ location: 'ميناء' }), ['حدث مجهول', 'لقاء في الميناء'], 'place entity counts as location');
  assert.deepEqual(t({ participant: 'سارة' }), ['وفاة']);
  assert.deepEqual(t({ entityId: 1 }), ['حدث مجهول', 'سفر إلى القاهرة']);
  assert.deepEqual(t({ verification: ['disputed'] }), ['لقاء في الميناء']);
  assert.deepEqual(t({ precision: ['unknown'] }), ['حدث مجهول']);
  assert.match(C.toCsv(all), /^﻿"العنوان"/);
});

test('personal events live inside the entity and never become map nodes', () => {
  const data = base();
  const nodesBefore = data.nodes.length;
  const rec = C.applyPersonal(data, 1, draft({ title: 'سفر', type: 'travel', fromLocation: 'غزة', toLocation: 'القاهرة', participants: [] }));
  C.applyPersonal(data, 1, draft({ title: 'مرض', type: 'illness', date: '2025-02', datePrecision: 'approx', time: '', description: 'وصف طويل' }));
  assert.equal(data.nodes.length, nodesBefore, 'no new nodes');
  assert.equal(data.edges.length, 0, 'no new edges');
  assert.equal(data.nodes.find(n => n.id === 1).events.length, 2);
  assert.doesNotThrow(() => validateDataset(data));
  assert.equal(C.collectEvents(data.nodes, data.edges).length, 0, 'not shared events');
  const list = C.sortEvents(C.entityEvents(data.nodes, data.edges, 1));
  assert.deepEqual(list.map(e => [e.title, e.scope]), [['مرض', 'personal'], ['سفر', 'personal']]);
  assert.equal(C.placeText(list[1]), 'من غزة إلى القاهرة');
  assert.equal(list[0].description, 'وصف طويل');
  assert.equal(C.entityEvents(data.nodes, data.edges, 4).length, 0, 'other entities unaffected');
  // edit keeps the id; remove drops the empty list
  const edited = C.applyPersonal(data, 1, { ...draft({ title: 'سفر معدل', type: 'travel', fromLocation: 'غزة', toLocation: 'عمّان' }), id: rec.id });
  assert.equal(edited.id, rec.id); assert.equal(data.nodes.find(n => n.id === 1).events.length, 2);
  assert.equal(C.removePersonal(data, 1, rec.id), true);
  assert.equal(C.removePersonal(data, 1, data.nodes.find(n => n.id === 1).events[0].id), true);
  assert.equal(data.nodes.find(n => n.id === 1).events, undefined);
});

test('an entity lists its personal events together with the shared events it is linked to', () => {
  const data = base();
  C.applyPersonal(data, 1, draft({ title: 'شخصي', date: '2026-01-01' }));
  C.applyDraft(data, draft({ title: 'مشترك', date: '2026-02-01', participants: [{ id: 1 }, { id: 2 }] }), nextId);
  const list = C.sortEvents(C.entityEvents(data.nodes, data.edges, 1));
  assert.deepEqual(list.map(e => [e.title, e.scope]), [['شخصي', 'personal'], ['مشترك', 'group']]);
  assert.deepEqual(C.entityEvents(data.nodes, data.edges, 2).map(e => e.title), ['مشترك']);
  assert.equal(C.entityEvents(data.nodes, data.edges, data.nodes.find(C.isEventNode).id).length, 0, 'event entities have no personal tab');
});

test('promote a personal event to a shared Event entity, and demote it back', () => {
  const data = base();
  const rec = C.applyPersonal(data, 1, draft({ title: 'لقاء', attachments: [{ id: 'x', name: 'a.txt', mime: 'text/plain', size: 3, data: 'data:text/plain;base64,YWJj' }], sources: [{ title: 's', url: 'https://e.com' }] }));
  const node = C.promoteToShared(data, 1, rec.id, nextId);
  assert.equal(C.isEventNode(node), true);
  assert.equal(data.nodes.find(n => n.id === 1).events, undefined, 'removed from the owner');
  assert.equal(data.edges.length, 1);
  const ev = C.collectEvents(data.nodes, data.edges)[0];
  assert.deepEqual([ev.title, ev.participants.map(p => p.id), ev.attachments.length, ev.sources.length], ['لقاء', ['1'], 1, 1]);
  assert.doesNotThrow(() => validateDataset(data));
  const back = C.demoteToPersonal(data, node.id);
  assert.equal(back.ownerId, '1');
  assert.equal(data.nodes.some(C.isEventNode), false); assert.equal(data.edges.length, 0);
  const again = C.entityEvents(data.nodes, data.edges, 1)[0];
  assert.deepEqual([again.title, again.scope, again.attachments.length], ['لقاء', 'personal', 1]);
  // an event with several participants cannot be demoted
  const g = C.applyDraft(data, draft({ participants: [{ id: 1 }, { id: 2 }] }), nextId).node;
  assert.throws(() => C.demoteToPersonal(data, g.id), /كيان واحد/);
});

test('event location survives edits, copying, promotion, demotion and explicit removal', () => {
  const data = base();
  const geo = { lat: '31.5', lng: '34.4', place: 'غزة', photos: [{ src: 'data:image/png;base64,AA', caption: 'صورة' }] };
  const rec = C.applyPersonal(data, 1, draft({ geo }));
  const ev = C.personalEvents(data.nodes[0])[0];
  assert.equal(ev.geo.place, 'غزة');
  const copy = C.draftFromEvent(ev); copy.geo.photos[0].caption = 'تعديل';
  assert.equal(rec.geo.photos[0].caption, 'صورة', 'draft does not alias stored data');
  C.applyPersonal(data, 1, { ...draft(), id: rec.id });
  assert.equal(rec.geo.lat, 31.5, 'older editor does not erase a location');
  const shared = C.promoteToShared(data, 1, rec.id, nextId);
  assert.equal(shared.geo.place, 'غزة');
  const restored = C.demoteToPersonal(data, shared.id).rec;
  assert.equal(restored.geo.photos[0].caption, 'صورة');
  C.applyPersonal(data, 1, { ...draft(), id: restored.id, geo: null });
  assert.equal(restored.geo, undefined);
});
