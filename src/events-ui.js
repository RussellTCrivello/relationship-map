(function () {
  'use strict';
  // Events UI.
  //  * Personal events live inside an entity and are managed in the "الأحداث" tab of its Details panel
  //    (they are never map nodes).
  //  * Shared events are Event entities (map nodes) linked to their participants; they are listed in each
  //    participant's tab and shown/edited through the Event entity's own panel.
  // Logic lives in chronology.js; app.js provides the host.
  const C = window.RelationshipChronology;
  const H = () => window.RelationshipHost;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const safeUrl = u => (/^https?:\/\/\S+$/i.test(String(u || '').trim()) ? String(u).trim() : '');
  const bytes = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' م.ب' : Math.max(1, Math.round(n / 1024)) + ' ك.ب');
  const SCHEMA_AR = () => H().TYPE_AR || {};
  const ICON = {
    plus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    clock: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    pin: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/></svg>',
    file: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5"/></svg>',
    link: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/></svg>',
  };

  const sharedEvents = () => C.collectEvents(H().state.data.nodes, H().state.data.edges);
  const sharedById = id => sharedEvents().find(e => e.id === String(id));
  const ownerEvents = ownerId => C.entityEvents(H().state.data.nodes, H().state.data.edges, ownerId);
  const personalById = (ownerId, evId) => C.personalEvents(H().state.data.nodes.find(n => String(n.id) === String(ownerId)) || {}).find(e => e.id === String(evId));
  const initial = n => [...String(n.label || '•')][0] || '•';
  const commit = (message, focusId) => H().refreshAfterMutation(message, focusId, { keepView: true });

  // ---- shared renderers ------------------------------------------------------------------------------
  const typeChip = ev => { const t = C.typeInfo(ev.type); return `<span class="ev-chip" style="--c:${t.color}"><i></i>${esc(t.label)}</span>`; };
  const verBadge = ev => { const v = C.verificationInfo(ev.verification); return `<span class="ev-badge" style="--c:${v.color}" title="حالة التحقق">${esc(v.label)}</span>`; };
  const precBadge = ev => (ev.datePrecision === 'exact' ? '' : `<span class="ev-badge muted">${ev.datePrecision === 'approx' ? 'تقريبي' : 'بلا تاريخ'}</span>`);

  function bodyHtml(ev) {
    const place = C.placeText(ev);
    const sources = ev.sources.map(s => { const u = safeUrl(s.url); const name = s.title || s.url || 'مصدر'; return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${ICON.link}<span>${esc(name)}</span></a>` : `<span>${esc(name)}</span>`}${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`; }).join('');
    const atts = ev.attachments.map((a, i) => {
      const isImg = /^image\//.test(a.mime) && a.data;
      const open = a.data ? (isImg ? `<button type="button" class="ev-att-open" data-att-view="${i}">${ICON.file}<span>عرض</span></button>` : '')
        + `<a class="ev-att-open" href="${esc(a.data)}" download="${esc(a.name)}">تنزيل</a>` : (safeUrl(a.url) ? `<a class="ev-att-open" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">فتح الرابط ↗</a>` : '');
      return `<li class="ev-att">${isImg ? `<img src="${esc(a.data)}" alt="">` : `<span class="ev-att-ico">${ICON.file}</span>`}<span class="ev-att-name"><b>${esc(a.name)}</b><small>${a.data ? bytes(a.size || 0) : 'رابط خارجي'}</small></span>${open}</li>`;
    }).join('');
    return `<div class="ev-meta">${typeChip(ev)}${verBadge(ev)}${precBadge(ev)}</div>
      <p class="ev-when">${ICON.clock}<span>${esc(C.formatDate(ev))}</span></p>${place ? `<p class="ev-where">${ICON.pin}<span>${esc(place)}</span></p>` : ''}
      ${ev.description ? `<section><h4>الوصف</h4><p class="ev-text">${esc(ev.description)}</p></section>` : ''}
      ${ev.notes ? `<section><h4>ملاحظات</h4><p class="ev-text">${esc(ev.notes)}</p></section>` : ''}
      ${sources ? `<section><h4>المصادر <b>${ev.sources.length}</b></h4><ul class="ev-sources">${sources}</ul></section>` : ''}
      ${atts ? `<section><h4>المرفقات <b>${ev.attachments.length}</b></h4><ul class="ev-atts">${atts}</ul></section>` : ''}`;
  }
  function participantsHtml(ev) {
    const parts = ev.participants.map(p => {
      const sch = SCHEMA_AR()[p.node.schema] || p.node.schema || 'كيان';
      return `<li><button type="button" class="ev-person-main" data-goto="${esc(p.id)}" title="فتح ملف الكيان"><span class="ev-avatar">${esc(initial(p.node))}</span><span><b>${esc(p.node.label)}</b><small>${esc(sch)}${p.role ? ' · ' + esc(p.role) : ''}</small></span></button></li>`;
    }).join('');
    return `<section><h4>الكيانات المرتبطة بالحدث <b>${ev.participants.length}</b></h4>${parts ? `<ul class="ev-people">${parts}</ul>` : '<p class="empty-note">لا توجد كيانات مرتبطة بعد؛ اربط الكيانات بهذا الحدث من «العلاقات».</p>'}</section>`;
  }

  function goTo(id) { H().selectNode(String(id)); H().centerOn(String(id)); }
  function lightbox(att) {
    if (!att || !att.data) return;
    let box = $('#ev-lightbox');
    if (!box) {
      box = document.createElement('div'); box.id = 'ev-lightbox'; box.className = 'ev-lightbox';
      box.innerHTML = '<button type="button" class="icon-btn" aria-label="إغلاق">×</button><img alt="">';
      document.body.append(box);
      box.addEventListener('click', () => { box.classList.remove('open'); });
    }
    box.querySelector('img').src = att.data; box.classList.add('open');
  }

  // ---- delete / convert / unlink ---------------------------------------------------------------------
  const confirmSubject = ev => ({ name: ev.title, sub: `${C.typeLabel(ev.type)} · ${C.formatDate(ev)}`, color: C.typeInfo(ev.type).color });
  async function removePersonalWithConfirm(ownerId, evId) {
    const ev = personalById(ownerId, evId), h = H(), owner = h.state.byId.get(String(ownerId));
    if (!ev || !owner) return;
    const ok = await h.confirmDialog({ title: 'حذف الحدث؟', subject: confirmSubject(ev), message: `سيُحذف هذا الحدث من ملف «${owner.label}» نهائيًا.`, hint: 'يمكنك التراجع بعد الحذف بالضغط على Ctrl+Z.', confirmText: 'حذف الحدث' });
    if (!ok) return;
    C.removePersonal(h.state.data, ownerId, evId);
    tab.open.delete(String(evId));
    commit('تم حذف الحدث', String(ownerId));
  }
  async function removeSharedWithConfirm(id) {
    const ev = sharedById(id), h = H(); if (!ev) return;
    const names = ev.participants.map(p => p.node.label);
    const ok = await h.confirmDialog({
      title: 'حذف الحدث المشترك؟', subject: confirmSubject(ev),
      message: names.length ? `سيُحذف الحدث وعقدته من الخريطة، ويختفي من ملف ${names.length === 1 ? 'كيان واحد' : names.length + ' كيانات'}. الكيانات نفسها لن تُحذف.` : 'سيُحذف هذا الحدث وعقدته من الخريطة.',
      listTitle: names.length ? 'الكيانات المرتبطة' : '', items: names.slice(0, 6).concat(names.length > 6 ? [`+${names.length - 6} أخرى`] : []),
      hint: 'يمكنك التراجع بعد الحذف بالضغط على Ctrl+Z.', confirmText: 'حذف الحدث',
    });
    if (!ok) return;
    C.removeEvent(h.state.data, id);
    if (h.state.selected === String(id)) h.state.selected = null;
    commit('تم حذف الحدث', h.state.selected);
  }
  async function unlinkWithConfirm(ownerId, evId) {
    const ev = sharedById(evId), h = H(), owner = h.state.byId.get(String(ownerId));
    if (!ev || !owner) return;
    const ok = await h.confirmDialog({ title: 'إزالة الكيان من الحدث؟', subject: confirmSubject(ev), message: `سيبقى الحدث على الخريطة لبقية الكيانات، ولن يظهر بعد الآن في ملف «${owner.label}».`, confirmText: 'إزالة من الحدث', danger: false });
    if (!ok) return;
    h.state.data.edges = h.state.data.edges.filter(e => !((String(e.source) === String(ownerId) && String(e.target) === String(evId)) || (String(e.target) === String(ownerId) && String(e.source) === String(evId))));
    commit(`أُزيل «${owner.label}» من الحدث`, String(ownerId));
  }
  async function promote(ownerId, evId) {
    const ev = personalById(ownerId, evId), h = H(); if (!ev) return;
    const ok = await h.confirmDialog({ title: 'تحويل إلى حدث مشترك؟', subject: confirmSubject(ev), message: 'سيُنشأ كيان من نوع «حدث» يظهر على الخريطة ومرتبط بهذا الكيان، ويمكنك بعدها ربط كيانات أخرى به.', confirmText: 'تحويل إلى حدث مشترك', danger: false });
    if (!ok) return;
    const node = C.promoteToShared(h.state.data, ownerId, evId, h.nextId);
    tab.open.delete(String(evId));
    commit(`تم تحويل «${node.label}» إلى حدث مشترك على الخريطة`, String(ownerId));
  }
  async function demote(evId) {
    const ev = sharedById(evId), h = H(); if (!ev) return;
    if (ev.participants.length !== 1) { h.setStatus('يمكن التحويل إلى حدث شخصي فقط عندما يرتبط الحدث بكيان واحد', false); return; }
    const owner = ev.participants[0].node;
    const ok = await h.confirmDialog({ title: 'تحويل إلى حدث شخصي؟', subject: confirmSubject(ev), message: `ستُزال عقدة الحدث من الخريطة، ويبقى الحدث داخل ملف «${owner.label}» في قسم «الأحداث».`, confirmText: 'تحويل إلى حدث شخصي', danger: false });
    if (!ok) return;
    const res = C.demoteToPersonal(h.state.data, evId);
    if (h.state.selected === String(evId)) h.state.selected = null;
    tab.owner = String(res.ownerId); tab.q = ''; tab.type = ''; tab.open = new Set([String(res.rec.id)]);
    h.state.panelTab = 'events';
    commit(`أصبح الحدث شخصيًا داخل «${owner.label}»`, res.ownerId);
  }

  // ---- the Events tab of an entity -------------------------------------------------------------------
  const tab = { owner: null, q: '', type: '', open: new Set() };
  function cardHtml(ev, ownerId) {
    const open = tab.open.has(ev.id), shared = ev.scope === 'group';
    const meta = [C.typeLabel(ev.type), C.placeText(ev)].filter(Boolean).map(esc).join(' · ');
    const actions = shared
      ? `<button type="button" class="secondary-btn" data-open-shared="${esc(ev.id)}">فتح الحدث على الخريطة</button><button type="button" class="secondary-btn" data-shared-edit="${esc(ev.id)}">تعديل</button><button type="button" class="secondary-btn" data-unlink="${esc(ev.id)}">إزالة من الحدث</button>`
      : `<button type="button" class="secondary-btn" data-pe-edit="${esc(ev.id)}">تعديل</button><button type="button" class="secondary-btn" data-pe-dup="${esc(ev.id)}">نسخ</button><button type="button" class="secondary-btn" data-pe-promote="${esc(ev.id)}" title="ينشئ عقدة حدث على الخريطة ويربطها بهذا الكيان">تحويل إلى حدث مشترك</button><button type="button" class="danger-btn secondary-btn" data-pe-del="${esc(ev.id)}">حذف</button>`;
    const others = shared ? ev.participants.filter(p => p.id !== String(ownerId)) : [];
    return `<li class="ev-entry${open ? ' open' : ''}" data-ev="${esc(ev.id)}" style="--c:${C.typeInfo(ev.type).color}">
      <button type="button" class="ev-mini" data-ev-toggle="${esc(ev.id)}" aria-expanded="${open}"><span class="ev-dot"></span><span class="ev-mini-main"><span class="ev-mini-date">${esc(C.formatDate(ev))}</span><b>${esc(ev.title)}</b><small>${meta}</small></span><span class="ev-mini-badges">${shared ? '<span class="ev-badge shared" title="حدث مشترك يظهر على الخريطة">مشترك</span>' : ''}${verBadge(ev)}</span></button>
      <div class="ev-entry-body"${open ? '' : ' hidden'}>${bodyHtml(ev)}${shared && others.length ? `<section><h4>مشاركون آخرون <b>${others.length}</b></h4><ul class="ev-people">${others.map(p => `<li><button type="button" class="ev-person-main" data-goto="${esc(p.id)}"><span class="ev-avatar">${esc(initial(p.node))}</span><span><b>${esc(p.node.label)}</b><small>${esc(SCHEMA_AR()[p.node.schema] || '')}${p.role ? ' · ' + esc(p.role) : ''}</small></span></button></li>`).join('')}</ul></section>` : ''}<div class="ev-actions">${actions}</div></div></li>`;
  }
  function itemsHtml(ownerId) {
    const all = ownerEvents(ownerId);
    const list = C.sortEvents(C.filterEvents(all, { q: tab.q, types: tab.type ? [tab.type] : [] }));
    if (!all.length) return '<p class="empty-note">لا توجد أحداث لهذا الكيان بعد. أضف سفرًا أو انتقالًا أو مرضًا أو لقاءً أو أي حدث آخر. يمكن إظهار الحدث الشخصي على الخريطة بإضافة موقع إليه.</p>';
    if (!list.length) return '<p class="empty-note">لا توجد أحداث مطابقة للبحث.</p>';
    return `<ol class="ev-mini-list">${list.map(ev => cardHtml(ev, ownerId)).join('')}</ol>`;
  }
  function entityPanel(id) {
    id = String(id);
    if (tab.owner !== id) { tab.owner = id; tab.q = ''; tab.type = ''; tab.open = new Set(); }
    const all = ownerEvents(id);
    const types = [...new Set(all.map(e => e.type))];
    const filters = all.length > 4 ? `<div class="ev-tab-filters"><input type="search" data-ev-q placeholder="ابحث في الأحداث…" value="${esc(tab.q)}" autocomplete="off"><select data-ev-type aria-label="نوع الحدث"><option value="">كل الأنواع</option>${types.map(t => `<option value="${esc(t)}"${tab.type === t ? ' selected' : ''}>${esc(C.typeLabel(t))}</option>`).join('')}</select></div>` : '';
    return { count: all.length, html: `<div class="ev-panel" data-owner="${esc(id)}"><div class="ev-panel-actions"><button type="button" class="primary-btn" data-ev-add>${ICON.plus}<span>حدث جديد</span></button>${all.length ? '<button type="button" class="secondary-btn" data-ev-csv>تصدير CSV</button>' : ''}</div>${filters}<div class="ev-items">${itemsHtml(id)}</div></div>` };
  }

  // Event entity (shared event) panel.
  function eventPanel(id) {
    const ev = sharedById(id);
    if (!ev) return '<p class="empty-note">تعذر العثور على الحدث.</p>';
    const solo = ev.participants.length === 1;
    return `<article class="ev-detail-card" data-event="${esc(ev.id)}"><header><h3>${esc(ev.title)}</h3></header>${bodyHtml(ev)}${participantsHtml(ev)}<div class="ev-actions"><button type="button" class="secondary-btn" data-shared-edit="${esc(ev.id)}">تعديل</button><button type="button" class="secondary-btn" data-shared-dup="${esc(ev.id)}">نسخ</button>${solo ? `<button type="button" class="secondary-btn" data-shared-demote="${esc(ev.id)}" title="يزيل عقدة الحدث من الخريطة ويحفظه داخل الكيان المرتبط">تحويل إلى حدث شخصي</button>` : ''}<button type="button" class="danger-btn secondary-btn" data-shared-del="${esc(ev.id)}">حذف</button></div></article>`;
  }

  function wirePanel(root, id) {
    id = String(id);
    const panel = $('.ev-panel', root);
    if (panel) {
      const rerender = () => { $('.ev-items', panel).innerHTML = itemsHtml(id); };
      panel.addEventListener('click', e => {
        const t = e.target.closest('button,a'); if (!t || !panel.contains(t)) return;
        const d = t.dataset;
        if (d.evAdd !== undefined) openEditor({ mode: 'personal', ownerId: id });
        else if (d.evCsv !== undefined) exportCsv(id);
        else if (d.evToggle) { const k = d.evToggle; if (tab.open.has(k)) tab.open.delete(k); else tab.open.add(k); const li = t.closest('.ev-entry'); li.classList.toggle('open', tab.open.has(k)); $('.ev-entry-body', li).hidden = !tab.open.has(k); t.setAttribute('aria-expanded', String(tab.open.has(k))); }
        else if (d.peEdit) { const ev = personalById(id, d.peEdit); if (ev) openEditor({ mode: 'personal', ownerId: id, draft: C.draftFromEvent(ev) }); }
        else if (d.peDup) { const ev = personalById(id, d.peDup); if (ev) { const dr = C.draftFromEvent(ev); delete dr.id; dr.title += ' (نسخة)'; dr.attachments = dr.attachments.map(a => ({ ...a, id: undefined })); openEditor({ mode: 'personal', ownerId: id, draft: dr, copy: true }); } }
        else if (d.pePromote) promote(id, d.pePromote);
        else if (d.peDel) removePersonalWithConfirm(id, d.peDel);
        else if (d.openShared) goTo(d.openShared);
        else if (d.sharedEdit) editShared(d.sharedEdit);
        else if (d.unlink) unlinkWithConfirm(id, d.unlink);
        else if (d.goto) goTo(d.goto);
        else if (d.attView !== undefined) { const li = t.closest('.ev-entry'); const ev = ownerEvents(id).find(x => x.id === li.dataset.ev); if (ev) lightbox(ev.attachments[Number(d.attView)]); }
      });
      const q = $('[data-ev-q]', panel), ty = $('[data-ev-type]', panel);
      if (q) q.addEventListener('input', () => { tab.q = q.value; rerender(); });
      if (ty) ty.addEventListener('change', () => { tab.type = ty.value; rerender(); });
    }
    const card = $('.ev-detail-card', root);
    if (card) {
      const eid = card.dataset.event;
      card.addEventListener('click', e => {
        const t = e.target.closest('button'); if (!t) return;
        const d = t.dataset;
        if (d.goto) goTo(d.goto);
        else if (d.sharedEdit) editShared(d.sharedEdit);
        else if (d.sharedDup) { const ev = sharedById(d.sharedDup); if (ev) { const dr = C.draftFromEvent(ev); delete dr.id; dr.title += ' (نسخة)'; dr.attachments = dr.attachments.map(a => ({ ...a, id: undefined })); openEditor({ mode: 'shared', draft: dr, copy: true }); } }
        else if (d.sharedDemote) demote(d.sharedDemote);
        else if (d.sharedDel) removeSharedWithConfirm(d.sharedDel);
        else if (d.attView !== undefined) { const ev = sharedById(eid); if (ev) lightbox(ev.attachments[Number(d.attView)]); }
      });
    }
  }
  function editShared(id) { const ev = sharedById(id); if (ev) openEditor({ mode: 'shared', draft: C.draftFromEvent(ev) }); }
  function exportCsv(ownerId) {
    const owner = H().state.byId.get(String(ownerId)), list = C.sortEvents(ownerEvents(ownerId)); if (!list.length) return;
    const url = URL.createObjectURL(new Blob([C.toCsv(list)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `أحداث ${owner ? owner.label : ''}.csv`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- the editor (personal events and shared Event entities) ----------------------------------------
  function ensureEditor() {
    let m = $('#ev-edit'); if (m) return m;
    m = document.createElement('div'); m.id = 'ev-edit'; m.className = 'ev-modal ev-modal-top';
    m.innerHTML = '<div class="ev-backdrop" data-edit-close></div><section class="ev-card ev-editor" role="dialog" aria-modal="true" aria-labelledby="evx-heading"><header class="ev-head"><div><h2 id="evx-heading"></h2><p id="evx-sub"></p></div><button type="button" class="icon-btn" data-edit-close aria-label="إغلاق">×</button></header><form id="evx-form" novalidate></form></section>';
    document.body.append(m);
    m.addEventListener('click', e => { if (e.target.closest('[data-edit-close]')) closeEditor(); });
    return m;
  }
  function closeEditor() { const m = $('#ev-edit'); if (m) m.classList.remove('open'); }
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;

  // ctx: {mode:'personal'|'shared', ownerId?, draft?, copy?}
  function openEditor(ctx) {
    const h = H(), shared = ctx.mode === 'shared', draft = ctx.draft;
    const d = draft ? JSON.parse(JSON.stringify(draft)) : {
      title: '', type: 'activity', date: '', datePrecision: 'exact', time: '', location: '', fromLocation: '', toLocation: '', description: '', notes: '',
      sources: [], attachments: [], verification: 'unverified', participants: [],
    };
    d.participants = d.participants || [];
    d.attachments = (d.attachments || []).map((a, i) => ({ ...a, id: a.id || 'n' + Date.now().toString(36) + i }));
    const m = ensureEditor();
    const owner = ctx.ownerId !== undefined ? h.state.byId.get(String(ctx.ownerId)) : null;
    $('#evx-heading', m).textContent = d.id ? 'تعديل الحدث' : (ctx.copy ? 'حدث جديد (نسخة)' : 'حدث جديد');
    $('#evx-sub', m).textContent = shared ? 'حدث مشترك: يظهر على الخريطة ومرتبط بالكيانات التي تضيفها' : owner ? `حدث شخصي في ملف «${owner.label}» — يمكن إظهاره على الخريطة بإضافة موقع` : '';
    const customs = [...new Set([...allTypesInUse()].filter(t => !C.EVENT_TYPES.some(x => x.id === t)))].sort((a, b) => a.localeCompare(b, 'ar'));
    if (d.type && !C.EVENT_TYPES.some(t => t.id === d.type) && !customs.includes(d.type)) customs.push(d.type);
    const form = $('#evx-form', m);
    form.innerHTML = `
      <div class="ev-grid">
        <label class="editor-field wide"><span>عنوان الحدث *</span><input id="evx-title" value="${esc(d.title)}" maxlength="200" autocomplete="off"></label>
        <label class="editor-field"><span>نوع الحدث *</span><select id="evx-type">${C.EVENT_TYPES.map(t => opt(t.id, t.label, d.type === t.id)).join('')}${customs.map(t => opt(t, t + ' (مخصص)', d.type === t)).join('')}${opt('__new__', '＋ نوع مخصص جديد…')}</select></label>
        <label class="editor-field" id="evx-newtype-wrap" hidden><span>اسم النوع الجديد</span><input id="evx-newtype" maxlength="60" placeholder="مثال: مؤتمر صحفي" autocomplete="off"></label>
        <div class="editor-field wide"><span>حالة التحقق من المعلومة</span><div class="ev-seg" id="evx-ver" role="radiogroup">${C.VERIFICATION.map(v => `<button type="button" role="radio" data-v="${v.id}" aria-checked="${d.verification === v.id}" style="--c:${v.color}">${esc(v.label)}</button>`).join('')}</div></div>
        <div class="editor-field wide"><span>دقة التاريخ</span><div class="ev-seg" id="evx-prec" role="radiogroup">${C.PRECISION.map(p => `<button type="button" role="radio" data-v="${p.id}" aria-checked="${d.datePrecision === p.id}">${esc(p.label)}</button>`).join('')}</div></div>
        <label class="editor-field" id="evx-date-wrap"><span id="evx-date-label">التاريخ</span><input id="evx-date-exact" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(d.date) ? esc(d.date) : ''}"><input id="evx-date-approx" type="text" dir="ltr" inputmode="numeric" placeholder="2026-03 أو 2026" value="${esc(d.date)}" hidden></label>
        <label class="editor-field" id="evx-time-wrap"><span>الوقت (اختياري)</span><input id="evx-time" type="time" value="${esc(d.time)}"></label>
        <label class="editor-field wide" id="evx-loc-wrap"><span>مكان الحدث</span><input id="evx-loc" value="${esc(d.location)}" placeholder="مثال: مدينة غزة — حي الرمال" autocomplete="off"></label>
        <label class="editor-field" id="evx-from-wrap" hidden><span>المكان السابق / نقطة الانطلاق</span><input id="evx-from" value="${esc(d.fromLocation)}" autocomplete="off"></label>
        <label class="editor-field" id="evx-to-wrap" hidden><span>المكان الجديد / الوجهة</span><input id="evx-to" value="${esc(d.toLocation)}" autocomplete="off"></label>
        <label class="editor-field wide"><span>الوصف التفصيلي</span><textarea id="evx-desc" rows="4">${esc(d.description)}</textarea></label>
        <label class="editor-field wide"><span>ملاحظات</span><textarea id="evx-notes" rows="3">${esc(d.notes)}</textarea></label>
      </div>
      <details class="ev-sec" id="evx-location" ${d.geo ? 'open' : ''}><summary>الموقع (اختياري)</summary>
        <div id="evx-geo-fields"></div><button type="button" class="secondary-btn" id="evx-clear-geo">إزالة الموقع</button></details>
      ${shared ? `<section class="ev-sec"><h3>الكيانات المرتبطة بالحدث <small>يمكنك أيضًا ربطها لاحقًا من «العلاقات»</small></h3>
        <div class="ev-picker"><input id="evx-who" type="search" placeholder="ابحث عن كيان لإضافته…" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="evx-suggest"><div class="ev-suggest" id="evx-suggest" role="listbox" hidden></div></div>
        <ul class="ev-chips" id="evx-parts"></ul></section>` : ''}
      <section class="ev-sec"><h3>المصادر <button type="button" class="chip-btn" id="evx-add-src">${ICON.plus} مصدر</button></h3><div id="evx-srcs" class="ev-rows"></div></section>
      <section class="ev-sec"><h3>المرفقات <small>صور ومستندات حتى ${bytes(C.MAX_ATTACHMENT_BYTES)} للملف، تُحفظ داخل البرنامج</small></h3>
        <div class="ev-att-add"><button type="button" class="secondary-btn" id="evx-pick">رفع ملف من الجهاز</button><input type="file" id="evx-file" multiple hidden>
          <input id="evx-att-name" placeholder="اسم الرابط" autocomplete="off"><input id="evx-att-url" dir="ltr" placeholder="https://… رابط مرفق" autocomplete="off"><button type="button" class="chip-btn" id="evx-add-att">${ICON.plus} رابط</button></div>
        <ul class="ev-atts" id="evx-atts"></ul></section>
      <div class="ev-errors" id="evx-errors" role="alert" hidden></div>
      <div class="editor-actions"><button type="button" class="secondary-btn" data-edit-close>إلغاء</button><button type="submit" class="primary-btn">حفظ الحدث</button></div>`;
    wireEditor(form, d, ctx);
    m.classList.add('open');
    setTimeout(() => $('#evx-title', m)?.focus(), 30);
  }
  function allTypesInUse() {
    const h = H(), set = new Set();
    for (const n of h.state.data.nodes) {
      if (C.isEventNode(n) && n.eventType) set.add(n.eventType);
      if (Array.isArray(n.events)) n.events.forEach(r => r && r.type && set.add(r.type));
    }
    return set;
  }

  function wireEditor(form, d, ctx) {
    const h = H(), shared = ctx.mode === 'shared';
    const g = id => $(id, form);
    const location = window.RelationshipMap.mountLocationFields(g('#evx-geo-fields'), d.geo, {
      destination: true,
      onError: msgs => { const box = g('#evx-errors'); box.hidden = !msgs.length; box.innerHTML = msgs.map(msg => `<p>${esc(msg)}</p>`).join(''); },
      onPick: done => { const modal = $('#ev-edit'); modal.classList.remove('open'); window.RelationshipMap.pickLocation(pt => { done(pt); modal.classList.add('open'); }); },
    });
    g('#evx-clear-geo').addEventListener('click', () => location.clear());
    const syncType = () => {
      const v = g('#evx-type').value;
      g('#evx-newtype-wrap').hidden = v !== '__new__';
      const route = C.isRouteType(v);
      g('#evx-loc-wrap').hidden = route; g('#evx-from-wrap').hidden = !route; g('#evx-to-wrap').hidden = !route;
    };
    g('#evx-type').addEventListener('change', syncType); syncType();
    const seg = (id, set) => { const box = g(id); $$('button', box).forEach(b => b.addEventListener('click', () => { set(b.dataset.v); $$('button', box).forEach(x => x.setAttribute('aria-checked', String(x === b))); })); };
    seg('#evx-ver', v => { d.verification = v; });
    const syncDate = () => {
      const p = d.datePrecision, exact = g('#evx-date-exact'), approx = g('#evx-date-approx');
      exact.hidden = p !== 'exact'; approx.hidden = p !== 'approx';
      g('#evx-date-wrap').hidden = p === 'unknown'; g('#evx-time-wrap').hidden = p === 'unknown';
      g('#evx-date-label').textContent = p === 'approx' ? 'التاريخ التقريبي (سنة أو شهر أو يوم)' : 'التاريخ';
      if (p === 'unknown') g('#evx-time').value = '';
    };
    seg('#evx-prec', v => {
      const prev = d.datePrecision, ex = g('#evx-date-exact'), ap = g('#evx-date-approx');
      if (prev === 'exact' && v === 'approx' && ex.value) ap.value = ex.value;
      if (prev === 'approx' && v === 'exact') ex.value = /^\d{4}-\d{2}-\d{2}$/.test(ap.value.trim()) ? ap.value.trim() : '';
      d.datePrecision = v; syncDate();
    });
    syncDate();
    // participants (shared events only)
    if (shared) {
      const parts = g('#evx-parts');
      const renderParts = () => {
        parts.innerHTML = d.participants.map((p, i) => { const n = h.state.byId.get(String(p.id)) || { label: `كيان ${p.id}` }; return `<li class="ev-chip-row"><span class="ev-avatar">${esc(initial(n))}</span><span class="ev-chip-name"><b>${esc(n.label)}</b><small>${esc(SCHEMA_AR()[n.schema] || '')}</small></span><input class="ev-role" data-i="${i}" value="${esc(p.role)}" placeholder="الدور (اختياري)" aria-label="دور ${esc(n.label)}" autocomplete="off"><button type="button" class="icon-btn" data-rm="${i}" aria-label="إزالة ${esc(n.label)}">×</button></li>`; }).join('') || '<li class="empty-note">لم تُضف كيانات بعد.</li>';
        $$('.ev-role', parts).forEach(inp => inp.addEventListener('input', () => { d.participants[Number(inp.dataset.i)].role = inp.value; }));
        $$('[data-rm]', parts).forEach(b => b.addEventListener('click', () => { d.participants.splice(Number(b.dataset.rm), 1); renderParts(); }));
      };
      renderParts();
      const who = g('#evx-who'), sug = g('#evx-suggest'); let sIdx = -1, sItems = [];
      const showSug = () => {
        const q = C.norm(who.value), taken = new Set(d.participants.map(p => String(p.id)));
        sItems = h.state.nodes.filter(n => n.schema !== 'Event' && !taken.has(String(n.id)) && (!q || C.norm(`${n.label} ${n.labelEn || ''}`).includes(q))).slice(0, 8);
        sIdx = sItems.length ? 0 : -1;
        sug.hidden = !sItems.length; who.setAttribute('aria-expanded', String(!!sItems.length));
        sug.innerHTML = sItems.map((n, i) => `<button type="button" role="option" class="ev-sug${i === sIdx ? ' active' : ''}" data-i="${i}"><span class="ev-avatar">${esc(initial(n))}</span><span><b>${esc(n.label)}</b><small>${esc(SCHEMA_AR()[n.schema] || '')}</small></span></button>`).join('');
      };
      const pick = i => { const n = sItems[i]; if (!n) return; d.participants.push({ id: String(n.id), role: '' }); who.value = ''; sug.hidden = true; who.setAttribute('aria-expanded', 'false'); renderParts(); who.focus(); };
      who.addEventListener('input', showSug); who.addEventListener('focus', showSug);
      who.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!sItems.length) return; sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + sItems.length) % sItems.length; $$('.ev-sug', sug).forEach((b, i) => b.classList.toggle('active', i === sIdx)); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!sug.hidden) pick(Math.max(0, sIdx)); }
        else if (e.key === 'Escape' && !sug.hidden) { e.stopPropagation(); sug.hidden = true; }
      });
      sug.addEventListener('mousedown', e => { const b = e.target.closest('.ev-sug'); if (b) { e.preventDefault(); pick(Number(b.dataset.i)); } });
      who.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 120));
    }
    // sources
    const srcs = g('#evx-srcs');
    const renderSrcs = () => {
      srcs.innerHTML = d.sources.map((s, i) => `<div class="ev-row"><input data-k="title" data-i="${i}" value="${esc(s.title)}" placeholder="اسم المصدر" autocomplete="off"><input data-k="url" data-i="${i}" dir="ltr" value="${esc(s.url)}" placeholder="https://…" autocomplete="off"><input data-k="note" data-i="${i}" value="${esc(s.note)}" placeholder="ملاحظة" autocomplete="off"><button type="button" class="icon-btn" data-rm="${i}" aria-label="حذف المصدر">×</button></div>`).join('') || '<p class="empty-note">لا توجد مصادر.</p>';
      $$('input', srcs).forEach(inp => inp.addEventListener('input', () => { d.sources[Number(inp.dataset.i)][inp.dataset.k] = inp.value; }));
      $$('[data-rm]', srcs).forEach(b => b.addEventListener('click', () => { d.sources.splice(Number(b.dataset.rm), 1); renderSrcs(); }));
    };
    renderSrcs();
    g('#evx-add-src').addEventListener('click', () => { d.sources.push({ title: '', url: '', note: '' }); renderSrcs(); $$('input', srcs).slice(-3)[0]?.focus(); });
    // attachments
    const atts = g('#evx-atts');
    const renderAtts = () => {
      atts.innerHTML = d.attachments.map((a, i) => `<li class="ev-att">${/^image\//.test(a.mime) && a.data ? `<img src="${esc(a.data)}" alt="">` : `<span class="ev-att-ico">${ICON.file}</span>`}<span class="ev-att-name"><b>${esc(a.name)}</b><small>${a.data ? bytes(a.size || 0) : esc(a.url)}</small></span><button type="button" class="chip-btn" data-rm="${i}">إزالة</button></li>`).join('') || '<li class="empty-note">لا توجد مرفقات.</li>';
      $$('[data-rm]', atts).forEach(b => b.addEventListener('click', () => { d.attachments.splice(Number(b.dataset.rm), 1); renderAtts(); }));
    };
    renderAtts();
    const err = msgs => { const box = g('#evx-errors'); box.hidden = !msgs.length; box.innerHTML = msgs.map(m => `<p>${esc(m)}</p>`).join(''); if (msgs.length) box.scrollIntoView({ block: 'nearest' }); };
    g('#evx-pick').addEventListener('click', () => g('#evx-file').click());
    g('#evx-file').addEventListener('change', async e => {
      const problems = [];
      for (const f of [...e.target.files]) {
        try {
          let data, mime = f.type || 'application/octet-stream', size;
          if (/^image\/(png|jpe?g|webp|gif|bmp)$/.test(mime)) { data = await h.downscaleImage(await h.readFileAsDataUrl(f), 1280); mime = data.slice(5, data.indexOf(';')); size = Math.round((data.length - data.indexOf(',') - 1) * 0.75); }
          else { if (f.size > C.MAX_ATTACHMENT_BYTES) { problems.push(`«${f.name}» أكبر من ${bytes(C.MAX_ATTACHMENT_BYTES)}؛ أضفه كرابط بدلًا من ذلك.`); continue; } data = await h.readFileAsDataUrl(f); size = f.size; }
          if (size > C.MAX_ATTACHMENT_BYTES) { problems.push(`«${f.name}» ما زال أكبر من ${bytes(C.MAX_ATTACHMENT_BYTES)}.`); continue; }
          d.attachments.push({ id: 'n' + Date.now().toString(36) + d.attachments.length, name: f.name, mime, size, data });
        } catch (ex) { problems.push(`تعذر قراءة «${f.name}».`); }
      }
      e.target.value = ''; renderAtts(); err(problems);
    });
    g('#evx-add-att').addEventListener('click', () => {
      const url = g('#evx-att-url').value.trim(), name = g('#evx-att-name').value.trim();
      if (!safeUrl(url)) { err(['أدخل رابط مرفق صالحًا يبدأ بـ http أو https.']); return; }
      d.attachments.push({ id: 'n' + Date.now().toString(36) + d.attachments.length, name: name || url, mime: '', size: 0, url }); g('#evx-att-url').value = ''; g('#evx-att-name').value = ''; renderAtts(); err([]);
    });
    // save
    form.onsubmit = e => {
      e.preventDefault();
      const typeSel = g('#evx-type').value, type = typeSel === '__new__' ? g('#evx-newtype').value.trim() : typeSel;
      const approx = d.datePrecision === 'approx';
      const draft = {
        id: d.id, title: g('#evx-title').value, type, datePrecision: d.datePrecision,
        date: d.datePrecision === 'unknown' ? '' : (approx ? g('#evx-date-approx').value.trim() : g('#evx-date-exact').value),
        time: g('#evx-time').value, location: g('#evx-loc').value, fromLocation: g('#evx-from').value, toLocation: g('#evx-to').value,
        geo: location.read(), description: g('#evx-desc').value, notes: g('#evx-notes').value, sources: d.sources, attachments: d.attachments, verification: d.verification, participants: shared ? d.participants : [],
      };
      if (typeSel === '__new__' && !type) { err(['اكتب اسم النوع المخصص.']); return; }
      const errors = [...C.validateDraft(draft), ...location.validate()];
      if (errors.length) { err(errors); return; }
      const size = JSON.stringify({ n: h.state.data.nodes, e: h.state.data.edges }).length + draft.attachments.reduce((s, a) => s + (a.data ? a.data.length : 0), 0) + (draft.geo ? draft.geo.photos.reduce((s, p) => s + p.src.length, 0) : 0);
      if (size > 12 * 1024 * 1024) { err(['حجم البيانات مع المرفقات كبير جدًا؛ استخدم روابط بدلًا من الملفات.']); return; }
      const isNew = d.id === undefined || d.id === null || d.id === '';
      let label, focus;
      if (shared) { const res = C.applyDraft(h.state.data, draft, h.nextId); label = res.node.label; focus = isNew ? String(res.node.id) : h.state.selected; }
      else { const rec = C.applyPersonal(h.state.data, ctx.ownerId, draft); label = rec.title; focus = String(ctx.ownerId); tab.open = new Set([String(rec.id)]); }
      closeEditor();
      commit(isNew ? `تمت إضافة الحدث «${label}»` : `تم تحديث الحدث «${label}»`, focus);
    };
  }

  // Esc closes only the top-most layer.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.querySelector('.confirm-modal')) return;
    const lb = $('#ev-lightbox.open'), ee = $('#ev-edit.open');
    if (lb) lb.classList.remove('open'); else if (ee) closeEditor(); else return;
    e.stopPropagation(); e.preventDefault();
  }, true);

  function editPersonal(ownerId, eventId) { const ev = personalById(ownerId, eventId); if (ev) openEditor({ mode: 'personal', ownerId, draft: C.draftFromEvent(ev) }); }
  window.RelationshipEvents = { edit: editShared, editPersonal, remove: removeSharedWithConfirm, entityPanel, eventPanel, wirePanel };
})();
