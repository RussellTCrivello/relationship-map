(function (root) {
  'use strict';
  // Pure optional entity profile helpers. No I/O and no browser state.
  const C = root.RelationshipChronology || (typeof require === 'function' ? require('./chronology.js') : null);
  const RELATIONS = ['أب','أم','أخ','أخت','زوج','زوجة','ابن','ابنة','جد','جدة','عم','عمة','خال','خالة','حفيد','حفيدة','قريب آخر','أخرى'];
  const MARITAL = [
    { id:'single', label:'أعزب / عزباء' }, { id:'married', label:'متزوج / متزوجة' },
    { id:'divorced', label:'مطلق / مطلقة' }, { id:'widowed', label:'أرمل / أرملة' },
    { id:'separated', label:'منفصل / منفصلة' }, { id:'engaged', label:'مخطوب / مخطوبة' }, { id:'other', label:'أخرى' },
  ];
  const HEALTH_STATUS = ['جيدة','مستقرة','مرض مزمن','إصابة','حرجة','غير معروفة','أخرى'];
  const FAMILY_STATUS = ['على قيد الحياة','متوفى','غير معروف'];
  const PERSONAL = ['birthDate','birthPlace','gender','nationality','idNumber','phone','phone2','email','address','occupation','education','notes'];
  const ROLE = ['title','group','groupId','since','until','notes'];
  const HEALTH = ['status','medications','allergies','bloodType','disability','lastCheck','notes'];
  const FAMILY = ['id','relation','relationLabel','name','entityId','birthDate','status','phone','notes'];
  const LIMITS = { notes:4000, maritalNote:4000, medications:4000, allergies:4000, disability:4000 };
  const s = (v, max=200) => typeof v === 'string' ? v.trim().slice(0,max) : '';
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const fields = (input, keys) => {
    const out = {}, source = obj(input);
    for (const k of keys) { const value=s(source[k],LIMITS[k] || 200); if (value) out[k]=value; }
    return out;
  };
  const has = x => Object.keys(x).length > 0;
  const validDate = d => !d || !!C.parseDate(d);
  function validateProfile(input) {
    const p=obj(input), errors=[];
    const enums = (value,allowed,label) => { if (value && !allowed.includes(value)) errors.push(`${label} غير صالحة.`); };
    const date = (value,label) => { if (value && !validDate(String(value).trim())) errors.push(`${label} غير صالح؛ استخدم سنة أو سنة-شهر أو سنة-شهر-يوم.`); };
    enums(p.maritalStatus, MARITAL.map(x=>x.id), 'الحالة الاجتماعية');
    enums(obj(p.health).status,HEALTH_STATUS,'الحالة الصحية');
    date(obj(p.personal).birthDate,'تاريخ الميلاد'); date(obj(p.role).since,'تاريخ بدء الدور'); date(obj(p.role).until,'تاريخ انتهاء الدور'); date(obj(p.health).lastCheck,'تاريخ آخر فحص');
    if (Array.isArray(p.family) && p.family.length>100) errors.push('الحد الأقصى 100 فرد من العائلة.');
    for (const [i,m] of (Array.isArray(p.family)?p.family:[]).entries()) {
      const f=obj(m); enums(f.relation,RELATIONS,`صلة الفرد ${i+1}`); enums(f.status,FAMILY_STATUS,`حالة الفرد ${i+1}`); date(f.birthDate,`تاريخ ميلاد الفرد ${i+1}`);
      if (f.relation === 'أخرى' && !s(f.relationLabel)) errors.push(`اكتب صلة الفرد ${i+1} الأخرى.`);
    }
    if (Array.isArray(obj(p.health).conditions) && obj(p.health).conditions.length>50) errors.push('الحد الأقصى 50 حالة صحية.');
    return errors;
  }
  function normalizeProfile(input) {
    const p=obj(input), out={};
    const personal=fields(p.personal,PERSONAL);
    if (personal.birthDate && !validDate(personal.birthDate)) delete personal.birthDate;
    if (has(personal)) out.personal=personal;
    const marital=s(p.maritalStatus); if (MARITAL.some(x=>x.id===marital)) out.maritalStatus=marital;
    const maritalNote=s(p.maritalNote,4000); if (maritalNote) out.maritalNote=maritalNote;
    const role=fields(p.role,ROLE); for (const k of ['since','until']) if (role[k] && !validDate(role[k])) delete role[k];
    if (has(role)) out.role=role;
    const family=[];
    for (const [i,item] of (Array.isArray(p.family)?p.family:[]).slice(0,100).entries()) {
      const f=fields(item,FAMILY);
      if (f.relation && !RELATIONS.includes(f.relation)) delete f.relation;
      if (f.relation !== 'أخرى') delete f.relationLabel;
      if (f.status && !FAMILY_STATUS.includes(f.status)) delete f.status;
      if (f.birthDate && !validDate(f.birthDate)) delete f.birthDate;
      const meaningful=Object.keys(f).some(k=>k!=='id');
      if (meaningful) { if (!f.id) f.id=`f${i+1}`; family.push(f); }
    }
    if (family.length) out.family=family;
    const h=obj(p.health), health=fields(h,HEALTH);
    if (health.status && !HEALTH_STATUS.includes(health.status)) delete health.status;
    if (health.lastCheck && !validDate(health.lastCheck)) delete health.lastCheck;
    const conditions=(Array.isArray(h.conditions)?h.conditions:[]).map(x=>s(x)).filter(Boolean).slice(0,50);
    if (conditions.length) health.conditions=conditions;
    if (has(health)) out.health=health;
    return has(out) ? out : undefined;
  }
  const isEmptyProfile = p => !normalizeProfile(p);
  function ageFromBirthDate(date, today=new Date()) {
    const p=C.parseDate(date); if (!p || !(today instanceof Date) || Number.isNaN(today.getTime())) return null;
    const y=today.getFullYear(), m=today.getMonth()+1, d=today.getDate();
    if (p.y>y || (p.y===y && p.m!==null && p.m>m) || (p.y===y && p.m===m && p.d!==null && p.d>d)) return null;
    let age=y-p.y;
    if (p.m!==null && (m<p.m || (m===p.m && p.d!==null && d<p.d))) age--;
    return { age:Math.max(0,age), approximate:p.grain!=='day' };
  }
  function maskId(value) { const v=s(value,4000); if (!v) return ''; const chars=[...v]; return chars.length<=4 ? '••••' : `••••${chars.slice(-4).join('')}`; }
  const maskPhone = maskId;
  function reciprocalRelation(relation, gender) {
    const g=s(gender).toLowerCase(), male=['male','ذكر','رجل'].includes(g), female=['female','أنثى','انثى','امرأة'].includes(g);
    if (['أب','أم'].includes(relation)) return male ? 'ابن' : female ? 'ابنة' : null;
    if (['ابن','ابنة'].includes(relation)) return male ? 'أب' : female ? 'أم' : null;
    if (['أخ','أخت'].includes(relation)) return male ? 'أخ' : female ? 'أخت' : null;
    if (['زوج','زوجة'].includes(relation)) return male ? 'زوج' : female ? 'زوجة' : null;
    if (['جد','جدة'].includes(relation)) return male ? 'حفيد' : female ? 'حفيدة' : null;
    if (['حفيد','حفيدة'].includes(relation)) return male ? 'جد' : female ? 'جدة' : null;
    return null; // Cannot safely infer uncles, guardians or an unknown gender.
  }
  function hasFamilyEdge(edges,a,b) {
    return (Array.isArray(edges)?edges:[]).some(e=>e && e.type==='Family' && ((String(e.source)===String(a) && String(e.target)===String(b)) || (String(e.source)===String(b) && String(e.target)===String(a))));
  }
  function hasSensitiveQuery(nodes, query) {
    const q=s(query,4000).toLocaleLowerCase();if (!q) return false;
    const digits=x=>x.replace(/[^0-9]/g,'');
    for (const n of Array.isArray(nodes)?nodes:[]) {
      const p=obj(n.profile),person=obj(p.personal),health=obj(p.health),values=[person.idNumber,person.phone,person.phone2,person.email,...(Array.isArray(p.family)?p.family.map(x=>obj(x).phone):[]),...Object.values(health).flatMap(x=>Array.isArray(x)?x:[x])];
      for(const value of values){const v=s(value,4000).toLocaleLowerCase();if(!v)continue;
        if((v.length>=3&&q.includes(v))||(q.length>=4&&v.includes(q)))return true;
        const a=digits(q),b=digits(v);if(a.length>=4&&b.length>=4&&(a.includes(b)||b.includes(a)))return true;
      }
    }
    return false;
  }
  function exportProfile(input, includeSensitive=false) {
    const p=normalizeProfile(input); if (!p) return undefined;
    if (!includeSensitive) {
      if (p.personal) for (const key of ['idNumber','phone','phone2','email']) delete p.personal[key];
      delete p.health;
      if (p.family) p.family.forEach(m=>delete m.phone);
    }
    return normalizeProfile(p);
  }
  const api={ RELATIONS, MARITAL, HEALTH_STATUS, FAMILY_STATUS, normalizeProfile, isEmptyProfile, validateProfile, ageFromBirthDate, maskId, maskPhone, reciprocalRelation, hasFamilyEdge, exportProfile, hasSensitiveQuery };
  root.RelationshipProfile=api;
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
