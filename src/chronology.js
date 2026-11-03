(function (root) {
  'use strict';
  // Pure event-chronology logic (no DOM), shared by the page and the tests.
  //
  // Two kinds of events, neither needing a server or database change:
  //  * personal events belong to one entity and live inside it (node.events[]); they are NOT map nodes.
  //  * shared (group) events are ordinary graph entities with schema "Event"; their participants are the
  //    entities connected to them by relationships, so one event can be linked to many entities.
  // Personal event record (node.events[i]) uses `title`/`description`; an Event entity uses `label`/`summary`.
  //   label            title
  //   eventType        built-in id below, or any other text = a custom type
  //   date             YYYY | YYYY-MM | YYYY-MM-DD
  //   datePrecision    exact | approx | unknown
  //   time             HH:MM (optional)
  //   location         where it happened; fromLocation / toLocation for travel and relocation
  //   summary          detailed description;  notes  free notes
  //   sources          [{title,url,note}];  attachments  [{id,name,mime,size,data|url}]
  //   verification     verified | probable | unverified | disputed

  const EVENT_TYPES = [
    { id: 'birth', label: 'ولادة', color: '#7bd88f' },
    { id: 'death', label: 'وفاة', color: '#9aa6b6' },
    { id: 'illness', label: 'مرض / حالة صحية', color: '#ff8fa3' },
    { id: 'travel', label: 'سفر', color: '#5fb8ff', route: true },
    { id: 'relocation', label: 'انتقال / تغيير مكان الإقامة', color: '#c3a0ff', route: true },
    { id: 'meeting', label: 'لقاء / اجتماع', color: '#ffc861' },
    { id: 'activity', label: 'نشاط', color: '#cdfe64' },
    { id: 'appointment', label: 'تعيين / منصب', color: '#6fe0d2' },
    { id: 'communication', label: 'تواصل / اتصال', color: '#8fb2ff' },
    { id: 'incident', label: 'حادثة', color: '#ff7a6b' },
    { id: 'legal', label: 'إجراء قانوني', color: '#e0a0d8' },
    { id: 'publication', label: 'إصدار / منشور', color: '#b7d36a' },
    { id: 'other', label: 'أخرى', color: '#b4bfcc' },
  ];
  const VERIFICATION = [
    { id: 'verified', label: 'موثّق', color: '#58d7a0' },
    { id: 'probable', label: 'مرجّح', color: '#cdfe64' },
    { id: 'unverified', label: 'غير مؤكد', color: '#ffc861' },
    { id: 'disputed', label: 'متنازع عليه', color: '#ff6b6b' },
  ];
  const PRECISION = [
    { id: 'exact', label: 'تاريخ دقيق' },
    { id: 'approx', label: 'تاريخ تقريبي' },
    { id: 'unknown', label: 'تاريخ غير معروف' },
  ];
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const MAX_ATTACHMENT_BYTES = 1.5 * 1024 * 1024;

  // Resolve lazily: chronology.js is loaded before geo.js in the browser.
  const geoApi = () => root.RelationshipGeo || (typeof require === 'function' ? require('./geo.js') : null);
  const typeById = new Map(EVENT_TYPES.map(t => [t.id, t]));
  const isEventNode = n => !!n && n.schema === 'Event';
  const typeInfo = id => typeById.get(id) || { id, label: id || 'أخرى', color: '#b4bfcc', custom: !!id };
  const typeLabel = id => typeInfo(id).label;
  const isRouteType = id => !!(typeById.get(id) && typeById.get(id).route);
  const verificationInfo = id => VERIFICATION.find(v => v.id === id) || VERIFICATION[2];

  // ---- dates -------------------------------------------------------------------------------------
  const pad = n => String(n).padStart(2, '0');
  function parseDate(s) {
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(s || '').trim());
    if (!m) return null;
    const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
    if (mo !== null && (mo < 1 || mo > 12)) return null;
    if (d !== null) {
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      if (d < 1 || d > last) return null;
    }
    return { y, m: mo, d, grain: d !== null ? 'day' : mo !== null ? 'month' : 'year' };
  }
  // The [start,end] days an event can fall in, as YYYY-MM-DD strings; null when the date is unknown.
  function dateRange(ev) {
    if (!ev || ev.datePrecision === 'unknown') return null;
    const p = parseDate(ev.date);
    if (!p) return null;
    if (p.grain === 'day') { const s = `${p.y}-${pad(p.m)}-${pad(p.d)}`; return [s, s]; }
    if (p.grain === 'month') return [`${p.y}-${pad(p.m)}-01`, `${p.y}-${pad(p.m)}-${pad(new Date(Date.UTC(p.y, p.m, 0)).getUTCDate())}`];
    return [`${p.y}-01-01`, `${p.y}-12-31`];
  }
  const sortKey = ev => { const r = dateRange(ev); return r ? r[0] + (ev.time ? 'T' + ev.time : 'T00:00') : null; };
  function formatDate(ev) {
    if (!ev || ev.datePrecision === 'unknown') return 'تاريخ غير معروف';
    const p = parseDate(ev.date);
    if (!p) return 'تاريخ غير معروف';
    const base = p.grain === 'day' ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : p.grain === 'month' ? `${MONTHS[p.m - 1]} ${p.y}` : String(p.y);
    const t = ev.time && /^\d{2}:\d{2}$/.test(ev.time) ? ` · ${ev.time}` : '';
    return (ev.datePrecision === 'approx' ? 'حوالي ' : '') + base + t;
  }

  // ---- normalising nodes into events ---------------------------------------------------------------
  const str = v => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
  function normalizeFields(src, title, description, id, scope) {
    const date = str(src.date);
    let precision = src.datePrecision;
    if (!['exact', 'approx', 'unknown'].includes(precision)) precision = date ? 'exact' : 'unknown';
    const sources = (Array.isArray(src.sources) ? src.sources : []).filter(x => x && typeof x === 'object')
      .map(x => ({ title: str(x.title), url: str(x.url), note: str(x.note) })).filter(x => x.title || x.url || x.note);
    const attachments = (Array.isArray(src.attachments) ? src.attachments : []).filter(a => a && typeof a === 'object' && (a.data || a.url))
      .map((a, i) => ({ id: str(a.id) || `a${i + 1}`, name: str(a.name) || 'مرفق', mime: str(a.mime), size: Number(a.size) || 0, data: a.data ? String(a.data) : '', url: str(a.url) }));
    const geo = geoApi() && geoApi().normalizeGeo(src.geo);
    return {
      ...(geo ? { geo } : {}),
      id: String(id), scope, title: str(title) || `حدث ${id}`, type: str(src.eventType) || 'other',
      date, datePrecision: precision, time: str(src.time),
      location: str(src.location), fromLocation: str(src.fromLocation), toLocation: str(src.toLocation),
      description: str(description), notes: str(src.notes), sources, attachments,
      verification: VERIFICATION.some(v => v.id === src.verification) ? src.verification : 'unverified',
    };
  }
  const normalizeEvent = node => normalizeFields(node, node.label, node.summary, node.id, 'group');
  // Personal records store the type as `type`; map it to the shared shape.
  const normalizePersonal = (rec, ownerId) => {
    const ev = normalizeFields({ ...rec, eventType: rec.type }, rec.title, rec.description, rec.id, 'personal');
    ev.ownerId = String(ownerId);
    ev.participants = [];
    return ev;
  };
  const placeText = ev => (isRouteType(ev.type) && (ev.fromLocation || ev.toLocation))
    ? [ev.fromLocation && `من ${ev.fromLocation}`, ev.toLocation && `إلى ${ev.toLocation}`].filter(Boolean).join(' ') : ev.location;

  // Every event with its participants, built in one pass over the edges.
  function collectEvents(nodes, edges) {
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const parts = new Map();
    for (const e of edges) {
      const s = String(e.source), t = String(e.target), sn = byId.get(s), tn = byId.get(t);
      if (!sn || !tn) continue;
      for (const [evNode, other, otherNode] of [[sn, t, tn], [tn, s, sn]]) {
        if (!isEventNode(evNode) || isEventNode(otherNode)) continue;
        const key = String(evNode.id);
        if (!parts.has(key)) parts.set(key, []);
        parts.get(key).push({ id: other, node: otherNode, edgeId: String(e.id), role: str(e.role) || (e.type === 'Participated_In' ? '' : str(e.label)) });
      }
    }
    return nodes.filter(isEventNode).map(n => {
      const ev = normalizeEvent(n);
      ev.participants = parts.get(ev.id) || [];
      ev.node = n;
      return ev;
    });
  }
  // Dated events first (ascending or descending), undated ones always last.
  function sortEvents(list, dir = 'asc') {
    const sign = dir === 'desc' ? -1 : 1;
    return list.slice().sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka && kb) return (ka < kb ? -1 : ka > kb ? 1 : 0) * sign || a.title.localeCompare(b.title, 'ar');
      if (ka) return -1;
      if (kb) return 1;
      return a.title.localeCompare(b.title, 'ar');
    });
  }
  const eventsOfEntity = (list, entityId) => list.filter(ev => ev.participants.some(p => p.id === String(entityId)));
  const customTypes = list => [...new Set(list.map(e => e.type).filter(t => t && !typeById.has(t)))].sort((a, b) => a.localeCompare(b, 'ar'));

  // ---- personal events (stored inside the entity) ---------------------------------------------------
  const personalEvents = node => (Array.isArray(node && node.events) ? node.events.filter(r => r && typeof r === 'object' && r.id !== undefined) : []).map(r => normalizePersonal(r, node.id));
  // Everything shown in one entity's Events tab: its personal events plus the shared events it is linked to.
  function entityEvents(nodes, edges, entityId) {
    const node = nodes.find(n => String(n.id) === String(entityId));
    if (!node || isEventNode(node)) return [];
    return [...personalEvents(node), ...eventsOfEntity(collectEvents(nodes, edges), entityId)];
  }
  const newPersonalId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Writes the event fields shared by both kinds onto `target` (a node or a personal record).
  function writeFields(target, d, keys) {
    const route = isRouteType(str(d.type));
    target[keys.type] = str(d.type);
    target.datePrecision = d.datePrecision;
    setOrDelete(target, 'date', d.datePrecision === 'unknown' ? '' : str(d.date));
    setOrDelete(target, 'time', d.datePrecision === 'unknown' ? '' : str(d.time));
    setOrDelete(target, 'location', route ? '' : str(d.location));
    setOrDelete(target, 'fromLocation', route ? str(d.fromLocation) : '');
    setOrDelete(target, 'toLocation', route ? str(d.toLocation) : '');
    setOrDelete(target, 'notes', str(d.notes));
    setOrDelete(target, 'sources', (d.sources || []).map(x => ({ title: str(x.title), url: str(x.url), note: str(x.note) })).filter(x => x.title || x.url || x.note));
    setOrDelete(target, 'attachments', (d.attachments || []).map(a => {
      const out = { id: str(a.id) || newPersonalId(), name: str(a.name) || 'مرفق', mime: str(a.mime), size: Number(a.size) || 0 };
      if (a.data) out.data = a.data; else out.url = str(a.url);
      return out;
    }));
    target.verification = VERIFICATION.some(v => v.id === d.verification) ? d.verification : 'unverified';
    // An omitted geo field means an older editor did not change the location.
    if (Object.prototype.hasOwnProperty.call(d, 'geo')) {
      if (d.geo == null) delete target.geo;
      else {
        const geo = geoApi() && geoApi().normalizeGeo(d.geo);
        if (!geo) throw new Error('إحداثيات الموقع غير صالحة.');
        target.geo = geo;
      }
    }
  }
  // Adds or updates a personal event on its owner. Mutates data in place and returns the stored record.
  function applyPersonal(data, ownerId, d) {
    const owner = data.nodes.find(n => String(n.id) === String(ownerId));
    if (!owner) throw new Error('الكيان غير موجود.');
    if (!Array.isArray(owner.events)) owner.events = [];
    let rec = d.id !== undefined && d.id !== null && d.id !== '' ? owner.events.find(r => String(r.id) === String(d.id)) : null;
    if (!rec) { rec = { id: newPersonalId() }; owner.events.push(rec); }
    rec.title = str(d.title);
    rec.description = str(d.description);
    if (!rec.description) delete rec.description;
    writeFields(rec, d, { type: 'type' });
    return rec;
  }
  function removePersonal(data, ownerId, eventId) {
    const owner = data.nodes.find(n => String(n.id) === String(ownerId));
    if (!owner || !Array.isArray(owner.events)) return false;
    const before = owner.events.length;
    owner.events = owner.events.filter(r => String(r.id) !== String(eventId));
    if (!owner.events.length) delete owner.events;
    return owner.events === undefined || owner.events.length !== before;
  }
  // Turns a personal event into a shared Event entity (a map node) linked to its owner, who can then link others.
  function promoteToShared(data, ownerId, eventId, nextId) {
    const owner = data.nodes.find(n => String(n.id) === String(ownerId));
    const rec = owner && (owner.events || []).find(r => String(r.id) === String(eventId));
    if (!rec) throw new Error('الحدث غير موجود.');
    const draft = draftFromEvent(normalizePersonal(rec, ownerId));
    delete draft.id;
    draft.participants = [{ id: String(ownerId), role: '' }];
    const res = applyDraft(data, draft, nextId);
    removePersonal(data, ownerId, eventId);
    return res.node;
  }
  // Moves a shared Event that has at most one linked entity back inside that entity (it stops being a map node).
  function demoteToPersonal(data, eventNodeId) {
    const ev = collectEvents(data.nodes, data.edges).find(e => e.id === String(eventNodeId));
    if (!ev) throw new Error('الحدث غير موجود.');
    if (ev.participants.length !== 1) throw new Error('يمكن تحويل الحدث إلى حدث شخصي فقط إذا كان مرتبطًا بكيان واحد.');
    const ownerId = ev.participants[0].id;
    const rec = applyPersonal(data, ownerId, { ...draftFromEvent(ev), id: undefined });
    removeEvent(data, eventNodeId);
    return { ownerId, rec };
  }

  // ---- search and filters --------------------------------------------------------------------------
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  function haystack(ev) {
    return norm([ev.title, typeLabel(ev.type), ev.description, ev.notes, ev.location, ev.fromLocation, ev.toLocation,
      ev.participants.map(p => `${p.node.label || ''} ${p.node.labelEn || ''} ${p.role}`).join(' '),
      ev.sources.map(s => `${s.title} ${s.note}`).join(' '), ev.attachments.map(a => a.name).join(' ')].join(' '));
  }
  // f: {q,types[],verification[],precision[],from,to,location,participant,entityId,includeUndated}
  function filterEvents(list, f = {}) {
    const q = norm(f.q), loc = norm(f.location), who = norm(f.participant);
    const types = f.types && f.types.length ? new Set(f.types) : null;
    const ver = f.verification && f.verification.length ? new Set(f.verification) : null;
    const prec = f.precision && f.precision.length ? new Set(f.precision) : null;
    const from = f.from || '', to = f.to || '';
    return list.filter(ev => {
      if (f.entityId !== undefined && f.entityId !== null && f.entityId !== '' && !ev.participants.some(p => p.id === String(f.entityId))) return false;
      if (types && !types.has(ev.type)) return false;
      if (ver && !ver.has(ev.verification)) return false;
      if (prec && !prec.has(ev.datePrecision)) return false;
      if (from || to) {
        const r = dateRange(ev);
        if (!r) { if (!f.includeUndated) return false; }
        else if ((from && r[1] < from) || (to && r[0] > to)) return false;
      }
      if (loc && !norm([ev.location, ev.fromLocation, ev.toLocation, ...ev.participants.filter(p => p.node.schema === 'Address').map(p => p.node.label)].join(' ')).includes(loc)) return false;
      if (who && !ev.participants.some(p => norm(`${p.node.label || ''} ${p.node.labelEn || ''}`).includes(who))) return false;
      if (q && !haystack(ev).includes(q)) return false;
      return true;
    });
  }

  // ---- validation and editing ----------------------------------------------------------------------
  // draft: {id?,title,type,date,datePrecision,time,location,fromLocation,toLocation,description,notes,
  //         sources[],attachments[],verification,participants:[{id,role}]}
  function validateDraft(d, opts = {}) {
    const errors = [];
    if (!str(d.title)) errors.push('عنوان الحدث مطلوب.');
    if (!str(d.type)) errors.push('نوع الحدث مطلوب.');
    if (!['exact', 'approx', 'unknown'].includes(d.datePrecision)) errors.push('اختر دقة التاريخ.');
    if (d.datePrecision !== 'unknown') {
      const p = parseDate(d.date);
      if (!str(d.date)) errors.push('أدخل التاريخ أو اختر «تاريخ غير معروف».');
      else if (!p) errors.push('صيغة التاريخ غير صحيحة (مثال: 2026-03-14 أو 2026-03 أو 2026).');
      else if (d.datePrecision === 'exact' && p.grain !== 'day') errors.push('التاريخ الدقيق يحتاج يومًا كاملًا؛ اختر «تقريبي» إذا كان الشهر أو السنة فقط.');
    }
    if (str(d.time)) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(str(d.time))) errors.push('صيغة الوقت غير صحيحة.');
      else if (d.datePrecision === 'unknown') errors.push('لا يمكن تحديد وقت لحدث بتاريخ غير معروف.');
    }
    for (const s of d.sources || []) {
      if (str(s.url) && !/^https?:\/\/\S+$/i.test(str(s.url))) errors.push(`رابط المصدر غير صالح: ${str(s.url).slice(0, 60)}`);
    }
    for (const a of d.attachments || []) {
      if (a.url && !/^https?:\/\/\S+$/i.test(a.url)) errors.push(`رابط المرفق غير صالح: ${String(a.url).slice(0, 60)}`);
      if (a.data && a.size > MAX_ATTACHMENT_BYTES) errors.push(`المرفق «${a.name}» أكبر من الحد المسموح.`);
    }
    const ids = (d.participants || []).map(p => String(p.id));
    if (opts.requireParticipants && !ids.length) errors.push('أضف مشاركًا واحدًا على الأقل (شخص أو منظمة أو موقع).');
    if (new Set(ids).size !== ids.length) errors.push('يوجد مشارك مكرر.');
    return errors;
  }
  const setOrDelete = (obj, key, value) => { if (value === '' || value === undefined || value === null || (Array.isArray(value) && !value.length)) delete obj[key]; else obj[key] = value; };

  // Creates or updates the event entity and syncs its participant relationships. Mutates data in place.
  function applyDraft(data, d, nextId) {
    let node = d.id !== undefined && d.id !== null ? data.nodes.find(n => String(n.id) === String(d.id)) : null;
    if (!node) {
      node = { id: nextId(data.nodes), label: '', labelEn: '', schema: 'Event', status: 'active', summary: '', photo: '', legalForm: '', country: '', url: '', boundary: false, subjects: [] };
      data.nodes.push(node);
    }
    node.label = str(d.title);
    node.schema = 'Event';
    node.summary = str(d.description);
    writeFields(node, d, { type: 'eventType' });

    const eid = String(node.id), want = new Map((d.participants || []).map(p => [String(p.id), str(p.role)]));
    let added = 0, removed = 0;
    data.edges = data.edges.filter(e => {
      const s = String(e.source), t = String(e.target);
      if (s !== eid && t !== eid) return true;
      const other = s === eid ? t : s;
      if (!want.has(other)) { removed++; return false; }
      e.role = want.get(other);
      want.delete(other); // already linked
      return true;
    });
    for (const [pid, role] of want) {
      data.edges.push({ id: nextId(data.edges), source: pid, target: eid, type: 'Participated_In', label: 'مشاركة في فعالية', role, confidence: 70, status: 'active' });
      added++;
    }
    return { node, added, removed };
  }
  function removeEvent(data, id) {
    const eid = String(id), before = data.edges.length;
    data.nodes = data.nodes.filter(n => String(n.id) !== eid);
    data.edges = data.edges.filter(e => String(e.source) !== eid && String(e.target) !== eid);
    return before - data.edges.length;
  }
  function draftFromEvent(ev) {
    return {
      id: ev.id, title: ev.title, type: ev.type, date: ev.date, datePrecision: ev.datePrecision, time: ev.time,
      location: ev.location, fromLocation: ev.fromLocation, toLocation: ev.toLocation, description: ev.description, notes: ev.notes,
      sources: ev.sources.map(s => ({ ...s })), attachments: ev.attachments.map(a => ({ ...a })), verification: ev.verification,
      participants: ev.participants.map(p => ({ id: p.id, role: p.role })),
      ...(ev.geo ? { geo: { ...ev.geo, photos: ev.geo.photos.map(p => ({ ...p })) } } : {}),
    };
  }

  // ---- CSV export ----------------------------------------------------------------------------------
  function toCsv(list) {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['العنوان', 'النوع', 'التاريخ', 'دقة التاريخ', 'الوقت', 'المكان', 'الوصف', 'الملاحظات', 'التوثيق', 'المشاركون', 'المصادر'];
    const rows = list.map(e => [e.title, typeLabel(e.type), e.date, PRECISION.find(p => p.id === e.datePrecision).label, e.time, placeText(e), e.description, e.notes,
      verificationInfo(e.verification).label, e.participants.map(p => p.node.label + (p.role ? ` (${p.role})` : '')).join(' | '), e.sources.map(s => s.url || s.title).join(' | ')]);
    return '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  }

  const api = {
    EVENT_TYPES, VERIFICATION, PRECISION, MAX_ATTACHMENT_BYTES, isEventNode, typeInfo, typeLabel, isRouteType, verificationInfo,
    parseDate, dateRange, sortKey, formatDate, normalizeEvent, placeText, collectEvents, sortEvents, eventsOfEntity, customTypes,
    norm, filterEvents, validateDraft, applyDraft, removeEvent, draftFromEvent, toCsv,
    normalizePersonal, personalEvents, entityEvents, applyPersonal, removePersonal, promoteToShared, demoteToPersonal,
  };
  root.RelationshipChronology = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
