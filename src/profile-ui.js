(function () {
  'use strict';
  const P=window.RelationshipProfile, H=()=>window.RelationshipHost;
  const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const note='هذه البيانات اختيارية، وتُخفى افتراضيًا وتُستبعد من التصدير ما لم تختر غير ذلك.';
  const labels={birthDate:'تاريخ الميلاد',birthPlace:'مكان الميلاد',gender:'الجنس',nationality:'الجنسية',idNumber:'رقم الهوية',phone:'الهاتف',phone2:'هاتف إضافي',email:'البريد الإلكتروني',address:'العنوان',occupation:'المهنة',education:'التعليم',notes:'ملاحظات',title:'الدور / المنصب',group:'المجموعة',groupId:'المجموعة المرتبطة',since:'من تاريخ',until:'إلى تاريخ',status:'الحالة الصحية',conditions:'الحالات الصحية',medications:'الأدوية',allergies:'الحساسية',bloodType:'فصيلة الدم',disability:'الإعاقة',lastCheck:'آخر فحص'};
  const personal=['birthDate','birthPlace','gender','nationality','idNumber','phone','phone2','email','address','occupation','education','notes'];
  const role=['title','group','since','until','notes'];
  const health=['status','conditions','medications','allergies','bloodType','disability','lastCheck','notes'];
  const sensitive=new Set(['idNumber','phone','phone2','email']);
  const revealed=new Set(); // Never persisted; keys contain IDs/field names, never values.
  const knownFields={personal:['birthDate','birthPlace','gender','nationality','idNumber','phone','phone2','email','address','occupation','education','notes'],role:['title','group','groupId','since','until','notes'],health:['status','conditions','medications','allergies','bloodType','disability','lastCheck','notes'],family:['id','relation','relationLabel','name','entityId','birthDate','status','phone','notes']};
  function preserveSection(oldValue,newValue,section){
    const old=oldValue&&typeof oldValue==='object'&&!Array.isArray(oldValue)?oldValue:{};
    const unknown=Object.fromEntries(Object.entries(old).filter(([key])=>!knownFields[section].includes(key)));
    const out={...unknown,...(newValue||{})};return Object.keys(out).length?out:undefined;
  }
  function updateProfile(original,normalized,part){
    const out={...(original&&typeof original==='object'&&!Array.isArray(original)?original:{})};
    if(part==='personal')for(const key of ['maritalStatus','maritalNote']){if(normalized?.[key])out[key]=normalized[key];else delete out[key];}
    for(const section of part==='personal'?['personal','role']:[part]){
      if(section==='family'){
        const old=Array.isArray(out.family)?out.family:[],incoming=normalized?.family||[];
        const members=incoming.map(m=>{const before=old.find((x,i)=>String(x?.id||`f${i+1}`)===String(m.id));return preserveSection(before,m,'family');});
        if(members.length)out.family=members;else delete out.family;
      }else{const v=preserveSection(out[section],normalized?.[section],section);if(v)out[section]=v;else delete out[section];}
    }
    return Object.keys(out).length?out:undefined;
  }
  const node=id=>H().state.byId.get(String(id));
  const uid=()=>`f${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
  const option=(value,text,selected)=>`<option value="${esc(value)}"${selected?' selected':''}>${esc(text)}</option>`;
  const input=(name,label,value,opts={})=>`<label class="editor-field ${opts.wide?'wide':''}"><span>${esc(label)}</span>${opts.area?`<textarea name="${esc(name)}" rows="3" maxlength="4000">${esc(value||'')}</textarea>`:`<input name="${esc(name)}" value="${esc(value||'')}" maxlength="200" ${opts.list?`list="${esc(opts.list)}"`:''} ${opts.date?'placeholder="YYYY أو YYYY-MM أو YYYY-MM-DD" inputmode="numeric" dir="ltr"':''}>`}</label>`;
  const select=(name,label,value,items)=>`<label class="editor-field"><span>${esc(label)}</span><select name="${esc(name)}">${option('','غير محدد',!value)}${items.map(x=>typeof x==='string'?option(x,x,x===value):option(x.id,x.label,x.id===value)).join('')}</select></label>`;
  function summary(n) {
    const p=n.profile||{}, age=P.ageFromBirthDate(p.personal?.birthDate), marital=P.MARITAL.find(x=>x.id===p.maritalStatus);
    const parts=[p.role?.title,marital?.label,age?`${age.approximate?'تقريبًا ':''}${age.age} سنة`:null].filter(Boolean);
    return parts.length?`<p class="profile-summary">${parts.map(esc).join(' · ')}</p>`:'';
  }
  function sectionCounts(n){const p=P.normalizeProfile(n.profile)||{};return {personal:!!(p.personal||p.maritalStatus||p.maritalNote||p.role),family:!!p.family,health:!!p.health};}
  function tabButtons(n){const c=sectionCounts(n);return [['personal','الشخصية'],['family','العائلة'],['health','الصحة']].map(([k,v])=>`<button type="button" role="tab" data-tab="profile-${k}">${v}${c[k]?' <b aria-label="توجد بيانات">●</b>':''}</button>`).join('');}
  function mask(value){return P.maskId(String(value));}
  function row(id,key,label,value,secret=false,copy=false){
    if (value===undefined||value===null||value===''||(Array.isArray(value)&&!value.length)) return '';
    const text=Array.isArray(value)?value.join('، '):String(value), token=`${id}:${key}`, shown=secret&&!revealed.has(token)?mask(text):text;
    return `<div class="profile-read-row"><dt>${esc(label)}</dt><dd><span data-profile-value="${esc(key)}">${esc(shown)}</span>${secret?` <button type="button" class="chip-btn" data-profile-reveal="${esc(key)}">${revealed.has(token)?'إخفاء':'إظهار'}</button>`:''}${copy?` <button type="button" class="chip-btn" data-profile-copy="${esc(key)}">نسخ</button>`:''}</dd></div>`;
  }
  function valueAt(p,key){ const parts=key.split('.'); if(parts[0]==='family') return p.family?.find(x=>String(x.id)===parts[1])?.[parts[2]]; return parts.reduce((x,k)=>x?.[k],p); }
  function familyGroup(r){if(['أب','أم'].includes(r))return 'الوالدان';if(['زوج','زوجة'].includes(r))return 'الزوج / الزوجة';if(['أخ','أخت'].includes(r))return 'الإخوة والأخوات';if(['ابن','ابنة'].includes(r))return 'الأبناء';return 'أقارب آخرون';}
  function panel(n,part){
    const p=P.normalizeProfile(n.profile)||{}, id=String(n.id);let content='';
    if(part==='personal'){
      const pp=p.personal||{}, rr=p.role||{};
      content=personal.map(k=>row(id,`personal.${k}`,labels[k],pp[k],sensitive.has(k),['idNumber','phone','phone2'].includes(k))).join('');
      const age=P.ageFromBirthDate(pp.birthDate); if(age) content+=row(id,'age','العمر',`${age.approximate?'تقريبًا ':''}${age.age} سنة`);
      content+=row(id,'maritalStatus','الحالة الاجتماعية',P.MARITAL.find(x=>x.id===p.maritalStatus)?.label)+row(id,'maritalNote','ملاحظة الحالة الاجتماعية',p.maritalNote);
      content+=role.map(k=>row(id,`role.${k}`,labels[k],rr[k])).join('');
      if(rr.groupId){const group=node(rr.groupId); if(group) content+=`<div class="profile-read-row"><dt>المجموعة المرتبطة</dt><dd><button type="button" class="chip-btn" data-profile-goto="${esc(group.id)}">${esc(H().labelOf(group))}</button></dd></div>`;}
    } else if(part==='health'){
      content=health.map(k=>row(id,`health.${k}`,labels[k],p.health?.[k],true)).join('');
    } else {
      const groups=new Map();for(const member of p.family||[]){const g=familyGroup(member.relation);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(member);}
      content=[...groups].map(([g,members])=>`<section class="profile-family-group"><h4>${esc(g)}</h4>${members.map(m=>{const linked=m.entityId&&node(m.entityId), name=m.name||(linked&&H().labelOf(linked))||'فرد من العائلة';return `<article class="profile-family-item"><strong>${esc(m.relation==='أخرى'?m.relationLabel||'أخرى':m.relation||'قريب')} · ${linked?`<button type="button" class="chip-btn" data-profile-goto="${esc(m.entityId)}">${esc(name)}</button>`:esc(name)}</strong><dl class="attribute-list">${row(id,`family.${m.id}.birthDate`,'تاريخ الميلاد',m.birthDate)}${row(id,`family.${m.id}.status`,'الحالة',m.status)}${row(id,`family.${m.id}.phone`,'الهاتف',m.phone,true,true)}${row(id,`family.${m.id}.notes`,'ملاحظات',m.notes)}</dl></article>`;}).join('')}</section>`).join('');
    }
    return `<div class="profile-panel"><button type="button" class="secondary-btn" data-profile-edit="${part}">تعديل</button>${content?(part==='family'?content:`<dl class="attribute-list">${content}</dl>`):'<p class="empty-note">لا توجد بيانات في هذا القسم.</p>'}</div>`;
  }
  function panels(n){return ['personal','family','health'].map(k=>`<div role="tabpanel" data-panel="profile-${k}" hidden>${panel(n,k)}</div>`).join('');}
  function wirePanel(root,id){
    for (const panel of $$('.profile-panel', root)) panel.addEventListener('click',async e=>{
      const b=e.target.closest('[data-profile-edit],[data-profile-reveal],[data-profile-copy],[data-profile-goto]'); if(!b)return;
      const n=node(id);if(!n)return;
      if(b.dataset.profileEdit){openEditor(id,b.dataset.profileEdit);return;}
      if(b.dataset.profileGoto){H().selectNode(String(b.dataset.profileGoto));H().centerOn(String(b.dataset.profileGoto));return;}
      if(b.dataset.profileReveal){const k=b.dataset.profileReveal, token=`${id}:${k}`, el=root.querySelector(`[data-profile-value="${CSS.escape(k)}"]`),v=valueAt(P.normalizeProfile(n.profile)||{},k);if(revealed.has(token)){revealed.delete(token);el.textContent=mask(Array.isArray(v)?v.join('، '):v);b.textContent='إظهار';}else{revealed.add(token);el.textContent=Array.isArray(v)?v.join('، '):v;b.textContent='إخفاء';}return;}
      if(b.dataset.profileCopy){const v=valueAt(P.normalizeProfile(n.profile)||{},b.dataset.profileCopy);try{await navigator.clipboard.writeText(String(v||''));H().setStatus('تم النسخ');}catch(_){H().setStatus('تعذر النسخ؛ اسمح بالوصول إلى الحافظة.',false);}}
    });
  }
  function modal(){
    let m=$('#profile-edit');if(m)return m;
    m=document.createElement('div');m.id='profile-edit';m.className='ev-modal ev-modal-top';m.innerHTML='<div class="ev-backdrop" data-profile-close></div><section class="ev-card ev-editor" role="dialog" aria-modal="true" aria-labelledby="profile-title"><header class="ev-head"><h2 id="profile-title"></h2><button type="button" class="icon-btn" data-profile-close aria-label="إغلاق">×</button></header><form id="profile-form" novalidate></form></section>';document.body.append(m);
    m.addEventListener('click',e=>{if(e.target.closest('[data-profile-close]'))close();});
    document.addEventListener('keydown',e=>{
      if(!m.classList.contains('open')||document.querySelector('.confirm-modal'))return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
      if(e.key==='Tab'){
        const focus=$$('button,input,select,textarea,a[href]',m).filter(x=>!x.disabled&&x.getClientRects().length);
        if(!focus.length)return;const first=focus[0],last=focus[focus.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    },true);
    return m;
  }
  let previousFocus=null;
  function close(){const m=$('#profile-edit');if(m){m.classList.remove('open');$('#profile-form',m).replaceChildren();if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});previousFocus=null;} }
  function familyRow(m={},i=0){
    const options=H().state.nodes.filter(n=>String(n.id)!==String($('#profile-edit')?.dataset.owner)).map(n=>option(`${H().labelOf(n)} — ${n.id}`,H().labelOf(n)));
    const linked=m.entityId&&node(m.entityId), search=linked?`${H().labelOf(linked)} — ${linked.id}`:m.entityId?`كيان غير متاح — ${m.entityId}`:'';
    return `<article class="profile-family-edit" data-family-id="${esc(m.id||uid())}"><div class="profile-row-head"><strong>فرد من العائلة</strong><div><button type="button" class="chip-btn" data-family-move="up" aria-label="نقل للأعلى">↑</button><button type="button" class="chip-btn" data-family-move="down" aria-label="نقل للأسفل">↓</button><button type="button" class="chip-btn" data-family-remove>حذف الفرد</button></div></div><div class="ev-grid">${select('relation','صلة القرابة',m.relation,P.RELATIONS)}${input('relationLabel','صلة أخرى (عند اختيار أخرى)',m.relationLabel)}${input('name','الاسم الحر',m.name)}${input('entitySearch','ربط بكيان موجود (اختياري)',search,{list:`profile-entities-${i}`})}<datalist id="profile-entities-${i}">${options.join('')}</datalist>${input('birthDate','تاريخ الميلاد',m.birthDate,{date:true})}${select('status','الحالة',m.status,P.FAMILY_STATUS)}${input('phone','الهاتف',m.phone)}${input('notes','ملاحظة',m.notes,{area:true,wide:true})}<label class="profile-check wide"><input type="checkbox" name="edge" checked> إنشاء علاقة عائلية في الشبكة عند الربط</label></div></article>`;
  }
  function openEditor(id,part){
    const n=node(id);if(!n)return;previousFocus=document.activeElement;const baseProfile=JSON.stringify(n.profile||null),p=P.normalizeProfile(n.profile)||{},m=modal(), oldForm=$('#profile-form',m), form=document.createElement('form');form.id='profile-form';form.noValidate=true;oldForm.replaceWith(form);m.dataset.owner=String(id);m.dataset.part=part;$('#profile-title',m).textContent=`تعديل ${part==='personal'?'البيانات الشخصية':part==='family'?'العائلة':'الصحة'} · ${H().labelOf(n)}`;
    const organizations=H().state.nodes.filter(x=>x.schema==='Organization'), group=p.role?.groupId&&node(p.role.groupId), groups=organizations.map(x=>option(`${H().labelOf(x)} — ${x.id}`,H().labelOf(x))).join('');
    if(part==='personal'){
      const pp=p.personal||{},r=p.role||{};
      form.innerHTML=`<div class="ev-grid">${personal.map(k=>input('personal.'+k,labels[k],pp[k],{date:k==='birthDate',area:k==='notes',wide:k==='notes'})).join('')}${select('maritalStatus','الحالة الاجتماعية',p.maritalStatus,P.MARITAL)}${input('maritalNote','ملاحظة الحالة الاجتماعية',p.maritalNote,{area:true,wide:true})}${role.map(k=>input('role.'+k,labels[k],r[k],{date:['since','until'].includes(k),area:k==='notes',wide:k==='notes',list:k==='title'?'profile-role-suggestions':undefined})).join('')}${input('role.groupSearch','ربط بجهة موجودة (اختياري)',group?`${H().labelOf(group)} — ${group.id}`:r.groupId?`كيان غير متاح — ${r.groupId}`:'',{list:'profile-organizations'})}<datalist id="profile-organizations">${groups}</datalist><datalist id="profile-role-suggestions">${['مدير','نائب المدير','عضو','منسق','مسؤول','مستشار','متطوع'].map(x=>option(x,x)).join('')}</datalist></div>`;
    } else if(part==='health'){
      const h=p.health||{};form.innerHTML=`<div class="ev-grid">${select('health.status','الحالة الصحية',h.status,P.HEALTH_STATUS)}${health.filter(k=>k!=='status').map(k=>input('health.'+k,labels[k],k==='conditions'?(h[k]||[]).join('، '):h[k],{date:k==='lastCheck',area:['conditions','medications','allergies','disability','notes'].includes(k),wide:['conditions','medications','allergies','disability','notes'].includes(k)})).join('')}</div><p class="empty-note">افصل الحالات الصحية بفاصلة.</p>`;
    } else {
      form.innerHTML=`<div id="profile-family-list">${(p.family||[]).map(f=>familyRow(f,uid())).join('')}</div><button type="button" class="secondary-btn" id="profile-family-add">＋ إضافة فرد</button>`;
    }
    form.insertAdjacentHTML('beforeend',`<p class="profile-privacy">${note}</p><div class="ev-errors" id="profile-errors" role="alert" aria-live="polite" hidden></div><div class="editor-actions"><button type="button" class="secondary-btn" data-profile-close>إلغاء</button><button type="submit" class="primary-btn">حفظ</button></div>`);
    const errors=$('#profile-errors',form),removed=[];
    function read(){
      const next=JSON.parse(JSON.stringify(p)), fd=new FormData(form);
      if(part==='personal'){
        next.personal={};next.role={};for(const k of personal)next.personal[k]=fd.get('personal.'+k)||'';for(const k of role)next.role[k]=fd.get('role.'+k)||'';
        next.maritalStatus=fd.get('maritalStatus')||'';next.maritalNote=fd.get('maritalNote')||'';
        const query=String(fd.get('role.groupSearch')||'').trim(), match=organizations.find(x=>`${H().labelOf(x)} — ${x.id}`===query);if(query&&!match&&query!==`كيان غير متاح — ${p.role?.groupId}`)throw Error('اختر جهة موجودة من القائمة أو امسح حقل الربط.');if(match)next.role.groupId=String(match.id);else if(query&&p.role?.groupId)next.role.groupId=p.role.groupId;
      } else if(part==='health'){
        next.health={};for(const k of health)next.health[k]=k==='conditions'?String(fd.get('health.'+k)||'').split(/[,،\n]/):fd.get('health.'+k)||'';
      } else {
        next.family=$$('.profile-family-edit',form).map(r=>{
          const f={id:r.dataset.familyId};for(const k of ['relation','relationLabel','name','birthDate','status','phone','notes'])f[k]=$(`[name="${k}"]`,r).value;
          const q=$('[name="entitySearch"]',r).value.trim();const target=H().state.nodes.find(x=>String(x.id)!==String(id)&&`${H().labelOf(x)} — ${x.id}`===q), previous=(p.family||[]).find(x=>String(x.id)===r.dataset.familyId);if(q&&!target&&q!==`كيان غير متاح — ${previous?.entityId}`)throw Error('اختر كيانًا من القائمة أو امسح حقل ربط الفرد.');
          if(target){f.entityId=String(target.id);if(!f.name.trim())f.name=H().labelOf(target);}else if(q&&previous?.entityId)f.entityId=previous.entityId;return f;
        });
      }
      return next;
    }
    function validate(){try{const v=read(),issues=P.validateProfile(v);errors.hidden=!issues.length;errors.textContent=issues.join(' ');return issues.length?null:v;}catch(err){errors.hidden=false;errors.textContent=err.message;return null;}}
    form.addEventListener('input',validate);form.addEventListener('change',validate);
    if(part==='family'){
      $('#profile-family-add',form).addEventListener('click',()=>{const list=$('#profile-family-list',form);if(list.children.length>=100){errors.hidden=false;errors.textContent='الحد الأقصى 100 فرد.';return;}list.insertAdjacentHTML('beforeend',familyRow({},uid()));});
      form.addEventListener('click',async e=>{const r=e.target.closest('.profile-family-edit');if(!r)return;const move=e.target.closest('[data-family-move]');if(move){const sibling=move.dataset.familyMove==='up'?r.previousElementSibling:r.nextElementSibling;if(sibling){if(move.dataset.familyMove==='up')r.parentElement.insertBefore(r,sibling);else r.parentElement.insertBefore(sibling,r);}return;}if(e.target.closest('[data-family-remove]')){
        const old=(p.family||[]).find(x=>String(x.id)===r.dataset.familyId);if(old?.entityId&&P.hasFamilyEdge(H().state.data.edges,id,old.entityId)){const removeEdge=await H().confirmDialog({title:'حذف الفرد من العائلة',message:'هل تريد حذف العلاقة العائلية في الشبكة أيضًا؟ سيُحذف الفرد من القائمة في الحالتين عند حفظ التغييرات.',confirmText:'حذف العلاقة أيضًا',cancelText:'الإبقاء على العلاقة',danger:false});if(removeEdge)removed.push(old.entityId);}
        r.remove();validate();
      }});
    }
    form.addEventListener('submit',async e=>{
      e.preventDefault();const next=validate();if(!next)return;const h=H(), proposals=[];
      const unchanged=()=>node(id) && JSON.stringify(node(id).profile||null)===baseProfile;
      const conflict=()=>{errors.hidden=false;errors.textContent='تغيّرت بيانات هذا الكيان أثناء التحرير؛ ألغِ النافذة وأعد فتحها حتى لا تُستبدل التغييرات.';};
      if(!unchanged()){conflict();return;}
      if(part==='family'){
        const old=p.family||[], rows=$$('.profile-family-edit',form), all=next.family||[];
        for(let i=0;i<all.length;i++){
          const member=all[i];if(!member.entityId||!$('[name="edge"]',rows[i]).checked)continue;
          const prev=old.find(x=>String(x.id)===String(member.id));if(prev&&String(prev.entityId||'')===String(member.entityId)&&P.hasFamilyEdge(h.state.data.edges,id,member.entityId))continue;
          const target=node(member.entityId);if(!target)continue;
          const inverse=P.reciprocalRelation(member.relation,p.personal?.gender)||'قريب آخر', other=P.normalizeProfile(target.profile)||{};
          let reciprocal=false;
          if((other.family||[]).length<100 && !(other.family||[]).some(f=>String(f.entityId||'')===String(id))){
            reciprocal=await h.confirmDialog({title:'إضافة فرد متبادل؟',message:`إضافة «${h.labelOf(n)}» إلى عائلة «${h.labelOf(target)}» بصلة «${inverse}»؟ يمكنك تعديلها لاحقًا.`,confirmText:'إضافة',cancelText:'ليس الآن',danger:false});
          }
          proposals.push({member,inverse,reciprocal});
        }
        if(!unchanged()){conflict();return;}
        const owner=node(id), edges=[...h.state.data.edges];
        for(const {member,inverse,reciprocal} of proposals){
          const target=node(member.entityId);if(!target)continue;
          if(!P.hasFamilyEdge(edges,id,member.entityId))edges.push({id:h.nextId(edges),source:owner.id,target:target.id,type:'Family',label:member.relation==='أخرى'?member.relationLabel:member.relation||'عائلة',confidence:70,status:'active'});
          const other=P.normalizeProfile(target.profile)||{};
          if(reciprocal&&(other.family||[]).length<100&&!(other.family||[]).some(f=>String(f.entityId||'')===String(id))){other.family=[...(other.family||[]),{id:uid(),relation:inverse,name:h.labelOf(owner),entityId:String(id)}];target.profile=updateProfile(target.profile,P.normalizeProfile(other),'family');}
        }
        h.state.data.edges=edges.filter(edge=>{
          for(const targetId of removed){
            if(all.some(x=>String(x.entityId||'')===String(targetId)))continue;
            if(edge.type==='Family'&&((String(edge.source)===String(id)&&String(edge.target)===String(targetId))||(String(edge.target)===String(id)&&String(edge.source)===String(targetId))))return false;
          }
          return true;
        });
      }
      const owner=node(id),normalized=updateProfile(owner.profile,P.normalizeProfile(next),part);if(normalized)owner.profile=normalized;else delete owner.profile;
      close();h.refreshAfterMutation('تم تحديث بيانات الكيان',String(id),{keepView:true});
    });
    m.classList.add('open');form.querySelector('input,select,textarea')?.focus({preventScroll:true});
  }
  function compare(n){return `<div data-profile-compare="${esc(n.id)}">${['personal','family','health'].map((k,i)=>`<h4>${['الشخصية','العائلة','الصحة'][i]}</h4>${panel(n,k).replace(/<button type="button" class="secondary-btn" data-profile-edit="[^"]+">تعديل<\/button>/,'')}`).join('')}</div>`;}
  window.RelationshipProfileUI={tabButtons,panels,wirePanel,summary,compare};
})();
