(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = { Person:'#cffe64', Organization:'#8d86ff', Address:'#58d7a0', Event:'#ff6b70', Thing:'#9ba4b2', UserAccount:'#9ba4b2' };
  const TYPE_AR = {Person:'شخص', Organization:'منظمة', Address:'عنوان / موقع', Event:'حدث', Thing:'كيان', UserAccount:'حساب مستخدم'};
  // Stored values stay in English (data model); everything shown to people is Arabic.
  const EDGE_TYPE_AR = {Associate:'ارتباط', Membership:'عضوية', Family:'عائلة', Located_At:'موقع مرتبط', Participated_In:'مشاركة في حدث', Impersonates:'انتحال / تمثيل', Sanctioned:'عقوبات', Employment:'عمل', Ownership:'ملكية', Directorship:'إدارة', Succession:'خلافة', Other:'أخرى'};
  const ATTR_KEY_AR = {name:'الاسم', alias:'الاسم المستعار', aliases:'أسماء مستعارة', address:'العنوان', email:'البريد الإلكتروني', phone:'الهاتف', website:'الموقع الإلكتروني', notes:'ملاحظات', birthDate:'تاريخ الميلاد', nationality:'الجنسية', position:'المنصب', role:'الدور', city:'المدينة', date:'التاريخ', description:'الوصف', gender:'الجنس'};
  function typeAr(t){const k=String(t??'');return EDGE_TYPE_AR[k]||(/^[A-Za-z_ -]+$/.test(k)?k.replace(/_/g,' '):k);}
  function attrKeyAr(k){return ATTR_KEY_AR[k]||k;}
  function countryAr(c){const v=String(c??'').trim();if(!v||/^(xx|zz|unknown)$/i.test(v))return '';if(/^[A-Za-z]{2}$/.test(v)){try{return new Intl.DisplayNames(['ar'],{type:'region'}).of(v.toUpperCase())||v;}catch(_){}}return v;}
  const $ = (s) => document.querySelector(s);
  const svg = $('#network-svg'), viewport = $('#viewport'), edgesLayer = $('#edges-layer'), nodesLayer = $('#nodes-layer');
  const STORAGE_KEY='relationship-network-dataset-v1';
  const STORAGE_BACKUP_KEY='relationship-network-dataset-backup-v1';
  const HISTORY_KEY='relationship-network-audit-v1';
  const AUTO_LAYOUT_KEY='relationship-network-auto-layout-v1', AUTO_LAYOUT_ENABLED_KEY='relationship-network-auto-layout-enabled-v1';
  let autoLayoutTimer=null;
  const MAX_HISTORY=40, MAX_AUDIT=200;
  let undoStack=[], redoStack=[], auditLog=[], lastCommittedSnapshot=null, lastPersistedSnapshot=null, replayingHistory=false, hasUnsavedChanges=false;
  // Database persistence: 'db' = saving to PostgreSQL via the API, 'local' = browser only, 'halted' = DB writes stopped (conflict / rejected).
  let dbMode='local', dbRevision=0, saveQueue=null, layoutQueue=null, dbRetrying=false, lastSaveMessage='', dbHaltMessage='';
  const api=window.RelationshipApi.createApiClient();
  // ---- Sign-in (only when the server provides it) ----
  let reloginOpen=false;
  function setAuthUser(name){const b=$('#account-btn');if(!b)return;b.hidden=!name;if(name)b.title=`الحساب: ${name}`;b.dataset.user=name||'';}
  // Shows the login screen and resolves with the user name once the sign-in succeeds.
  function showLogin(notice){
    return new Promise(resolve=>{
      const scr=$('#login-screen'),form=$('#login-form'),err=$('#login-error'),btn=$('#login-submit');
      scr.hidden=false;document.body.classList.add('auth-locked');
      $('#login-notice').textContent=notice||'';$('#login-notice').hidden=!notice;err.textContent='';
      setTimeout(()=>$('#login-user').focus(),30);
      form.onsubmit=async e=>{
        e.preventDefault();err.textContent='';btn.disabled=true;
        try{const r=await api.login($('#login-user').value,$('#login-pass').value);$('#login-pass').value='';scr.hidden=true;document.body.classList.remove('auth-locked');form.onsubmit=null;resolve(r.username);}
        catch(ex){err.textContent=ex.message||'تعذر تسجيل الدخول';$('#login-pass').select();}
        finally{btn.disabled=false;}
      };
    });
  }
  async function ensureLoggedIn(){
    const s=await api.me();
    if(s.status==='ok')setAuthUser(s.username);
    else if(s.status==='unauthorized')setAuthUser(await showLogin());
  }
  function openAccount(){
    const user=$('#account-btn').dataset.user||'';
    openToolModal('الحساب',`<p class="phase4-intro">مسجّل الدخول باسم: <b>${esc(user)}</b></p>
      <form id="password-form" class="account-form" autocomplete="off"><h3>تغيير كلمة المرور</h3>
      <label class="editor-field"><span>كلمة المرور الحالية</span><input id="pw-current" type="password" autocomplete="current-password" required></label>
      <label class="editor-field"><span>كلمة المرور الجديدة (8 أحرف على الأقل)</span><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="editor-field"><span>تأكيد كلمة المرور الجديدة</span><input id="pw-confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      <p id="pw-msg" class="account-msg" role="status" aria-live="polite"></p>
      <div class="editor-actions"><button type="submit" class="primary-btn" id="pw-submit">تغيير كلمة المرور</button><button type="button" class="danger-btn" id="logout-btn">تسجيل الخروج</button></div></form>`,modal=>{
      const msg=modal.querySelector('#pw-msg'),say=(t,bad)=>{msg.textContent=t;msg.classList.toggle('bad',!!bad);};
      modal.querySelector('#password-form').addEventListener('submit',async e=>{
        e.preventDefault();const cur=modal.querySelector('#pw-current').value,nw=modal.querySelector('#pw-new').value,cf=modal.querySelector('#pw-confirm').value;
        if(nw!==cf){say('تأكيد كلمة المرور غير مطابق.',true);return;}
        const btn=modal.querySelector('#pw-submit');btn.disabled=true;
        try{await api.changePassword(cur,nw);say('تم تغيير كلمة المرور. سُجّل خروجك من الأجهزة الأخرى.');['#pw-current','#pw-new','#pw-confirm'].forEach(i=>{modal.querySelector(i).value='';});}
        catch(ex){say(ex.message||'تعذر تغيير كلمة المرور.',true);}
        finally{btn.disabled=false;}
      });
      modal.querySelector('#logout-btn').addEventListener('click',async()=>{try{await api.logout();}catch(_){}location.reload();});
    });
  }
  const toPayload=data=>({nodes:data.nodes.map(cleanRecord),edges:data.edges.map(cleanRecord),zones:(data.zones||[]).map(cleanRecord)});
  const state = { data:{nodes:[],edges:[],zones:[]}, nodes:[], edges:[], byId:new Map(), adjacency:new Map(), positions:new Map(), selected:null, selectedEdgeKey:null, hovered:null, hoverTimer:null, suppressClickId:null, search:'', schema:'all', layout:'grouped', scale:1, tx:0, ty:0, dragging:null, panning:null, pointer:null, filteredIds:new Set(), matchIds:new Set(), edgeType:'all', lockNodes:false, hopLimit:0, pathNodeIds:new Set(), pathEdgeKeys:new Set(), collapsedGroups:new Set(), profileFilters:{role:'',marital:'',health:'',family:'',minAge:'',maxAge:'',sensitiveSearch:false}, showRole:false };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nodeId = v => String(v);
  function setStatus(text, ok=true){ $('#dataset-status').textContent=text; $('#dataset-status').style.color=ok?'var(--green)':'var(--red)'; }
  function schemaColor(schema){ return COLORS[schema] || COLORS.Thing; }
  function labelOf(n){ return n.label || n.name || `كيان ${n.id}`; }
  function edgeType(e){ return e.label || e.type || 'علاقة'; }
  function getRadius(n){ const degree=(state.adjacency.get(nodeId(n.id))||[]).length; const base=n.schema==='Organization'?30:22; return Math.round(base + Math.min(1,Math.sqrt(degree)/6)*12); }
  function buildGraph(data){
    state.data={nodes:(data.nodes||[]).map(n=>({...n})),edges:(data.edges||[]).map(e=>({...e})),zones:(data.zones||[]).map(z=>({...z}))};
    data=state.data;
    state.nodes=(data.nodes||[]).filter(n=>n.schema!=='UserAccount');
    const ids=new Set(state.nodes.map(n=>nodeId(n.id)));
    state.edges=(data.edges||[]).filter(e=>ids.has(nodeId(e.source))&&ids.has(nodeId(e.target)));
    state.byId=new Map(state.nodes.map(n=>[nodeId(n.id),n])); state.adjacency=new Map(state.nodes.map(n=>[nodeId(n.id),[]]));
    state.edges.forEach((e,i)=>{e._key=String(e.id??i); const a=nodeId(e.source),b=nodeId(e.target); state.adjacency.get(a)?.push({edge:e,other:b});state.adjacency.get(b)?.push({edge:e,other:a});});
    const schemas=[...new Set(state.nodes.map(n=>n.schema||'Thing'))].sort();
    $('#schema-filter').innerHTML='<option value="all">كل أنواع الكيانات</option>'+schemas.map(s=>`<option value="${esc(s)}">${esc(TYPE_AR[s]||s)}</option>`).join('');
    const edgeTypes=[...new Set(state.edges.map(e=>String(e.type||e.label||'علاقة')))].sort();
    $('#edge-filter').innerHTML='<option value="all">كل أنواع العلاقات</option>'+edgeTypes.map(t=>`<option value="${esc(t)}">${esc(typeAr(t))}</option>`).join('');
    $('#legend').innerHTML=schemas.map(s=>`<span class="legend-item"><i class="legend-dot" style="background:${schemaColor(s)}"></i>${esc(TYPE_AR[s]||s)}</span>`).join('');
    setStatus(`${state.nodes.length} كيان · ${state.edges.length} علاقة`);
    layout(); render(); updateCounts(); fitView();
  }
  function components(){
    const seen=new Set(), comps=[];
    for(const n of state.nodes){const id=nodeId(n.id);if(seen.has(id))continue;const q=[id],comp=[];seen.add(id);for(let qi=0;qi<q.length;qi++){const u=q[qi];comp.push(u);for(const x of state.adjacency.get(u)||[])if(!seen.has(x.other)){seen.add(x.other);q.push(x.other)}}comps.push(comp)}
    return comps.sort((a,b)=>b.length-a.length);
  }
  function layout(){
    const comps=components(), pos=new Map(), W=1200,H=760;
    const globalCenter={x:W/2,y:H/2};
    if(state.layout==='concentric' && comps.length){
      const ids=comps[0], idSet=new Set(ids), root=[...ids].sort((a,b)=>(state.adjacency.get(b)||[]).length-(state.adjacency.get(a)||[]).length)[0];
      const dist=new Map([[root,0]]),q=[root];for(let qi=0;qi<q.length;qi++){const u=q[qi];for(const v of state.adjacency.get(u)||[])if(idSet.has(v.other)&&!dist.has(v.other)){dist.set(v.other,dist.get(u)+1);q.push(v.other)}}
      const rings=new Map();ids.forEach(id=>{const d=dist.get(id)??99;if(!rings.has(d))rings.set(d,[]);rings.get(d).push(id)});
      for(const [d,arr] of [...rings].sort((a,b)=>a[0]-b[0])){arr.sort((a,b)=>(state.adjacency.get(b)||[]).length-(state.adjacency.get(a)||[]).length);const r=d===0?0:Math.min(290,95+d*82);arr.forEach((id,i)=>{const angle=(i/arr.length)*Math.PI*2-Math.PI/2;pos.set(id,{x:globalCenter.x+Math.cos(angle)*r,y:globalCenter.y+Math.sin(angle)*r})})}
      if(comps.length>1)placeOtherComponents(comps.slice(1),pos,W,H);
    } else if(state.layout==='classic'){
      let idx=0; for(const comp of comps){const compSet=new Set(comp);const root=comp.slice().sort((a,b)=>(state.adjacency.get(b)||[]).length-(state.adjacency.get(a)||[]).length)[0];const dist=new Map([[root,0]]),q=[root];for(let qi=0;qi<q.length;qi++){const u=q[qi];for(const v of state.adjacency.get(u)||[])if(compSet.has(v.other)&&!dist.has(v.other)){dist.set(v.other,dist.get(u)+1);q.push(v.other)}}const levels=new Map();comp.forEach(id=>{let d=dist.get(id)??1;if(!levels.has(d))levels.set(d,[]);levels.get(d).push(id)});const cx= comps.length===1?W/2:190+(idx%3)*410, cy=comps.length===1?H/2:170+Math.floor(idx/3)*380;for(const [d,arr] of levels){arr.sort((a,b)=>(state.adjacency.get(b)||[]).length-(state.adjacency.get(a)||[]).length);const r=d===0?0:Math.min(240,90+d*70);arr.forEach((id,i)=>{const a=i/arr.length*Math.PI*2-Math.PI/2;pos.set(id,{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r})})}idx++}
    } else {
      let compIndex=0; for(const comp of comps){const root=comp.slice().sort((a,b)=>{const na=state.byId.get(a),nb=state.byId.get(b);const oa=(na.schema==='Organization'?100:0)+(state.adjacency.get(a)||[]).length;const ob=(nb.schema==='Organization'?100:0)+(state.adjacency.get(b)||[]).length;return ob-oa})[0];const cx=comps.length===1?W/2:200+(compIndex%3)*400,cy=comps.length===1?H/2:190+Math.floor(compIndex/3)*350;
        const buckets=new Map();for(const id of comp){if(id===root)continue;const s=state.byId.get(id)?.schema||'Thing';if(!buckets.has(s))buckets.set(s,[]);buckets.get(s).push(id)}
        const types=[...buckets.keys()].sort(), total=types.length||1;pos.set(root,{x:cx,y:cy});types.forEach((type,ti)=>{const arr=buckets.get(type).sort((a,b)=>(state.adjacency.get(b)||[]).length-(state.adjacency.get(a)||[]).length);const mid=(ti/total)*Math.PI*2-Math.PI/2;const baseR=comp.length<5?120:Math.min(240,110+comp.length*4);arr.forEach((id,i)=>{const spread=Math.min(1.45,Math.PI*2/total*.82);const a=mid+(arr.length===1?0:((i/(arr.length-1))-.5)*spread);const r=baseR+Math.floor(i/7)*42;pos.set(id,{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r})})});compIndex++}
    }
    resolveOverlaps(pos);state.positions=pos;
  }
  function placeOtherComponents(comps,pos,W,H){comps.forEach((comp,i)=>{const cx=180+(i%3)*410,cy=160+Math.floor(i/3)*360;comp.forEach((id,j)=>{const a=j/comp.length*Math.PI*2,r=comp.length<2?0:Math.min(100,35+comp.length*5);pos.set(id,{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r})})})}
  function resolveOverlaps(pos){
    const ids=[...pos.keys()];
    if(ids.length<2)return;
    const iterations=ids.length<=150?18:ids.length<=400?8:3;
    const cellSize=120;
    for(let iter=0;iter<iterations;iter++){
      let moved=false;const buckets=new Map();
      for(const id of ids){const p=pos.get(id),key=`${Math.floor(p.x/cellSize)},${Math.floor(p.y/cellSize)}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);}
      for(const id of ids){
        const a=pos.get(id),cx=Math.floor(a.x/cellSize),cy=Math.floor(a.y/cellSize);
        for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++)for(const other of buckets.get(`${cx+ox},${cy+oy}`)||[]){
          if(String(other)<=String(id))continue;const b=pos.get(other);let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||.01;
          const min=getRadius(state.byId.get(id))+getRadius(state.byId.get(other))+25;
          if(d<min){const push=(min-d)*.34,ux=dx/d,uy=dy/d;a.x-=ux*push;a.y-=uy*push;b.x+=ux*push;b.y+=uy*push;moved=true;}
        }
      }
      if(!moved)break;
    }
    for(const p of pos.values()){p.x=Math.max(50,Math.min(1150,p.x));p.y=Math.max(70,Math.min(720,p.y));}
  }
  function svgEl(tag,attrs={}){const el=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));return el;}
  function render(){
    window.RelationshipMap&&window.RelationshipMap.dataChanged();
    edgesLayer.replaceChildren();nodesLayer.replaceChildren();
    for(const e of state.edges){if(isNodeCollapsed(nodeId(e.source))||isNodeCollapsed(nodeId(e.target)))continue;const a=state.positions.get(nodeId(e.source)),b=state.positions.get(nodeId(e.target));if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy)||1;const bend=Math.min(45,dist*.13)*(String(e.id).length%2?1:-1);const mx=(a.x+b.x)/2-dy/dist*bend,my=(a.y+b.y)/2+dx/dist*bend;const d=`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;const g=svgEl('g',{'data-edge':e._key});const path=svgEl('path',{d,class:`edge ${state.selectedEdgeKey===e._key?'edge-selected':''} ${String(e.type||'').toLowerCase().includes('sanction')?'sanction':''} ${e.status==='alleged'?'alleged':''}`,'data-source':nodeId(e.source),'data-target':nodeId(e.target)});g.append(path);const hit=svgEl('path',{d,class:'edge-hit',tabindex:'0',role:'button','aria-label':`تفاصيل العلاقة: ${edgeType(e)}`});hit.addEventListener('click',ev=>{ev.stopPropagation();selectEdge(e._key)});hit.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selectEdge(e._key)}});g.append(hit);const label=e.label||e.type;if(label&&dist>105&&(state.edges.length<=350||state.selectedEdgeKey===e._key)){const t=svgEl('text',{x:mx,y:my-4,class:'edge-label'});t.textContent=label.length>26?label.slice(0,25)+'…':label;g.append(t)}edgesLayer.append(g);e._group=g;e._path=path;e._label=g.querySelector('.edge-label')}
    for(const n of state.nodes){const id=nodeId(n.id),p=state.positions.get(id);if(!p||isNodeCollapsed(id))continue;const r=getRadius(n),g=svgEl('g',{class:'node','data-id':id,'data-schema':n.schema||'Thing',transform:`translate(${p.x} ${p.y})`,'tabindex':'0','role':'button','aria-label':`${labelOf(n)}، ${((state.adjacency.get(id)||[]).length)} علاقة`});const ring=svgEl('circle',{r,class:'node-ring',stroke:schemaColor(n.schema)});g.append(ring);
      if(n.photo){const clipId=`clip-${id.replace(/[^a-zA-Z0-9_-]/g,'_')}`;const defs=svgEl('defs');const clip=svgEl('clipPath',{id:clipId});clip.append(svgEl('circle',{r:Math.max(9,r-5)}));defs.append(clip);g.append(defs);const img=svgEl('image',{x:-r+5,y:-r+5,width:(r-5)*2,height:(r-5)*2,href:n.photo,preserveAspectRatio:'xMidYMid slice',class:'node-image', 'clip-path':`url(#${clipId})`});img.addEventListener('error',()=>img.remove());g.append(img)}else{g.append(svgEl('circle',{r:Math.max(9,r-5),class:'node-core'}));const initials=labelOf(n).trim().slice(0,1);const t=svgEl('text',{x:0,y:5,'text-anchor':'middle',fill:schemaColor(n.schema),class:'node-avatar','font-size':Math.min(22,r*.8),'font-weight':'700'});t.textContent=initials;g.append(t)}
      const degree=(state.adjacency.get(id)||[]).length;if(degree>0){const badge=svgEl('circle',{cx:r*.7,cy:-r*.7,r:9,fill:'#11151b',stroke:schemaColor(n.schema),'stroke-width':1.4});g.append(badge);const count=svgEl('text',{x:r*.7,y:-r*.7+3.5,class:'node-count'});count.textContent=degree;g.append(count)}
      if(state.collapsedGroups.has(String(n.schema||'Thing'))&&getGroupRepresentative(String(n.schema||'Thing'))===id){const total=state.nodes.filter(x=>String(x.schema||'Thing')===String(n.schema||'Thing')).length;const badge=svgEl('circle',{cx:-r*.7,cy:-r*.7,r:11,fill:'#151a11',stroke: '#CDFE64','stroke-width':1.5});g.append(badge);const count=svgEl('text',{x:-r*.7,y:-r*.7+3.5,class:'node-count'});count.textContent=total;g.append(count);}
      const label=svgEl('text',{x:0,y:r+18,class:'node-label'});const full=labelOf(n);label.textContent=full.length>24?full.slice(0,23)+'…':full;g.append(label);const title=svgEl('title');title.textContent=`${full} · ${TYPE_AR[n.schema]||n.schema||'كيان'}`;g.append(title);
      if(state.showRole&&n.profile?.role?.title){const roleText=svgEl('text',{x:0,y:r+34,class:'node-label profile-role-label'});roleText.textContent=n.profile.role.title;g.append(roleText);}
      g.addEventListener('click',e=>{e.stopPropagation();if(state.suppressClickId===id && Date.now()-(state.suppressClickAt||0)<500){state.suppressClickId=null;return;}state.suppressClickId=null;selectNode(id)});g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectNode(id)}});g.addEventListener('pointerdown',e=>startNodeDrag(e,id,g));g.addEventListener('pointerenter',()=>{if(state.hoverTimer)clearTimeout(state.hoverTimer);state.hoverTimer=setTimeout(()=>{state.hovered=id;state.hoverTimer=null;applyFilters();if(!state.selected)positionContextToolbar(id)},200)});g.addEventListener('pointerleave',ev=>{if(ev.relatedTarget&&ev.relatedTarget.closest&&ev.relatedTarget.closest('#node-context-toolbar'))return;if(state.hoverTimer){clearTimeout(state.hoverTimer);state.hoverTimer=null}if(state.hovered===id){state.hovered=null;applyFilters();if(!state.selected)hideContextToolbar()}});nodesLayer.append(g);n._el=g;
    }
    applyFilters();
    if(state.selected)positionContextToolbar(state.selected);else hideContextToolbar();
  }
  function getGroupRepresentative(schema){const members=state.nodes.filter(n=>String(n.schema||'Thing')===schema);return members.length?nodeId(members.slice().sort((a,b)=>(state.adjacency.get(nodeId(b.id))||[]).length-(state.adjacency.get(nodeId(a.id))||[]).length)[0].id):null;}
  function isNodeCollapsed(id){const n=state.byId.get(String(id));if(!n)return false;const schema=String(n.schema||'Thing');return state.collapsedGroups.has(schema)&&getGroupRepresentative(schema)!==String(id);}
  function neighborhoodDistances(start,maxDepth=Infinity){const dist=new Map();if(!start||!state.byId.has(String(start)))return dist;const q=[String(start)];dist.set(String(start),0);for(let i=0;i<q.length;i++){const u=q[i],d=dist.get(u);if(d>=maxDepth)continue;for(const rel of state.adjacency.get(u)||[]){if(!dist.has(rel.other)){dist.set(rel.other,d+1);q.push(rel.other);}}}return dist;}
  function applyFilters(){
    scheduleLabelLayout();
    const q=state.search.trim().toLocaleLowerCase();
    const f=state.profileFilters, P=window.RelationshipProfile;
    state.matchIds.clear();
    for(const n of state.nodes){
      const p=n.profile||{}, personal=p.personal||{}, marital=P.MARITAL.find(x=>x.id===p.maritalStatus);
      const family=Array.isArray(p.family)?p.family:[], secrets=f.sensitiveSearch?[personal.idNumber,personal.phone,personal.phone2,...family.map(x=>x.phone)]:[];
      const hay=[labelOf(n),n.id,n.labelEn,n.summary,n.schema,n.country,n.url,p.role?.title,p.role?.group,p.maritalStatus,marital?.label,...family.flatMap(x=>[x.relation,x.relationLabel,x.name]),...secrets,...(Array.isArray(n.subjects)?n.subjects:[])].filter(Boolean).join(' ').toLocaleLowerCase();
      const age=P.ageFromBirthDate(personal.birthDate), ageMatch=(!f.minAge||age&&age.age>=Number(f.minAge))&&(!f.maxAge||age&&age.age<=Number(f.maxAge));
      if((!q||hay.includes(q))&&(state.schema==='all'||n.schema===state.schema)&&(!f.role||String(p.role?.title||'').toLocaleLowerCase().includes(f.role.toLocaleLowerCase()))&&(!f.marital||p.maritalStatus===f.marital)&&(!f.health||p.health?.status===f.health)&&(!f.family||(f.family==='yes'?family.length>0:family.length===0))&&ageMatch)state.matchIds.add(nodeId(n.id));
    }
    const hasFilter=!!q||state.schema!=='all'||profileFiltersActive();
    state.filteredIds=new Set(state.matchIds);
    window.RelationshipMap&&window.RelationshipMap.sync();
    const focusId=state.hovered||state.selected;
    const focusDistances=focusId?neighborhoodDistances(focusId,state.hopLimit>0?state.hopLimit:1):new Map();
    // While a link is being dragged, no entity is dimmed: every one is a possible drop target.
    const linkingNow=!!(state.linking&&state.linking.moved);
    const focusNeighbors=linkingNow?new Set():new Set([...focusDistances.keys()].filter(id=>id!==focusId));
    for(const n of state.nodes){
      const id=nodeId(n.id),el=n._el;if(!el)continue;
      const filterDim=hasFilter&&!state.matchIds.has(id);
      const relationDim=!linkingNow&&!!focusId&&id!==focusId&&!focusNeighbors.has(id);
      const pathDim=state.pathNodeIds.size>0&&!state.pathNodeIds.has(id);
      el.classList.toggle('dimmed',filterDim||relationDim||pathDim||isNodeCollapsed(id));
      el.classList.toggle('path-node',state.pathNodeIds.has(id));
      el.classList.toggle('match',!!q&&state.matchIds.has(id));
      el.classList.toggle('selected',state.selected===id);
      el.classList.toggle('connected',!!focusId&&id!==focusId&&focusNeighbors.has(id));
      el.classList.toggle('focus-node',!!focusId&&id===focusId);
    }
    for(const e of state.edges){
      const a=nodeId(e.source),b=nodeId(e.target),el=e._path;
      const relevant=state.matchIds.has(a)&&state.matchIds.has(b);
      const filterDim=hasFilter&&!relevant;
      const pathDim=state.pathEdgeKeys.size>0&&!state.pathEdgeKeys.has(e._key);
      const typeDim=state.edgeType!=='all'&&String(e.type||e.label||'علاقة')!==state.edgeType;
      const relationHi=!linkingNow&&!!focusId&&(a===focusId||b===focusId);
      el?.classList.toggle('dimmed',filterDim||typeDim|| (!linkingNow&&!!focusId&&!relationHi)||pathDim||isNodeCollapsed(a)||isNodeCollapsed(b));
      el?.classList.toggle('path-edge',state.pathEdgeKeys.has(e._key));
      el?.classList.toggle('highlight',relationHi);el?.classList.toggle('edge-selected',state.selectedEdgeKey===e._key);
      if(e._label)e._label.classList.toggle('dimmed',filterDim||typeDim|| (!linkingNow&&!!focusId&&!relationHi)||pathDim||isNodeCollapsed(a)||isNodeCollapsed(b));
    }
    $('#empty-state').hidden=!(hasFilter && state.matchIds.size===0);
    updateCounts();
  }
  function profileFiltersActive(){const f=state.profileFilters;return !!(f.role||f.marital||f.health||f.family||f.minAge||f.maxAge);}
  function updateCounts(){const hasFilter=!!state.search||state.schema!=='all'||profileFiltersActive();const shown=hasFilter?state.matchIds.size:state.nodes.length;const visibleEdges=state.edges.filter(e=>(state.edgeType==='all'||String(e.type||e.label||'علاقة')===state.edgeType)&&state.matchIds.has(nodeId(e.source))&&state.matchIds.has(nodeId(e.target))).length;$('#visible-count').textContent=`${shown} / ${state.nodes.length} كيان · ${visibleEdges} علاقة`;drawMinimap();}
  function selectNode(id){if(!state.byId.has(id))return;state.selected=id;state.selectedEdgeKey=null;$('#panel-title').textContent='تفاصيل الكيان';$('#app-shell').classList.remove('panel-collapsed');$('#toggle-panel-btn').setAttribute('aria-expanded','true');$('#toggle-panel-btn').title='طي اللوحة';applyFilters();showDetails(id);positionContextToolbar(id)}
  function selectEdge(key){const edge=state.edges.find(e=>e._key===String(key));if(!edge)return;state.selected=null;state.selectedEdgeKey=edge._key;hideContextToolbar();applyFilters();showEdgeDetails(edge);}
  function confMeter(v){const n=Number(v);if(v===undefined||v===null||v===''||!isFinite(n))return '<div class="meter na"><span>—</span></div>';const c=Math.max(0,Math.min(100,n));return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c}"><i style="width:${c}%"></i><span>${c}%</span></div>`;}
  function statusBadge(v){const k=String(v||'unknown');return `<span class="badge st-${esc(/^[a-z]+$/.test(k)?k:'unknown')}">${esc(statusLabel(v)||'غير محدد')}</span>`;}
  function entityChip(n,id,attr){const col=schemaColor(n.schema);return `<button type="button" class="entity-chip" ${attr}="${esc(id)}" style="--c:${col}"><i class="legend-dot" style="background:${col}"></i><span><b>${esc(labelOf(n))}</b><small>${esc(TYPE_AR[n.schema]||n.schema||'كيان')}</small></span></button>`;}
  function wireTabs(root){const tabs=[...root.querySelectorAll('[role=tab]')];const show=name=>{state.panelTab=name;tabs.forEach(t=>{const on=t.dataset.tab===name;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;});root.querySelectorAll('[role=tabpanel]').forEach(p=>{p.hidden=p.dataset.panel!==name;});};tabs.forEach((t,i)=>{t.addEventListener('click',()=>show(t.dataset.tab));t.addEventListener('keydown',e=>{const d=e.key==='ArrowLeft'?1:e.key==='ArrowRight'?-1:0;if(!d)return;e.preventDefault();const nx=tabs[(i+d+tabs.length)%tabs.length];nx.focus();show(nx.dataset.tab);});});show(tabs.some(t=>t.dataset.tab===state.panelTab)?state.panelTab:tabs[0].dataset.tab);}
  function miniGraph(id,rels){const W=300,H=190,cx=W/2,cy=H/2,max=8,list=rels.filter(r=>state.byId.get(r.other));const seen=new Set(),uniq=[];list.forEach(r=>{if(!seen.has(r.other)){seen.add(r.other);uniq.push(r);}});const shown=uniq.slice(0,max),extra=uniq.length-shown.length,c=state.byId.get(id);if(!shown.length)return '';let g='';shown.forEach((r,i)=>{const ang=-Math.PI/2+i*2*Math.PI/shown.length,x=cx+Math.cos(ang)*108,y=cy+Math.sin(ang)*66,o=state.byId.get(r.other),out=nodeId(r.edge.source)===id;g+=`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="mg-edge" marker-end="${out?'url(#mg-arrow)':''}"/>`;});shown.forEach((r,i)=>{const ang=-Math.PI/2+i*2*Math.PI/shown.length,x=cx+Math.cos(ang)*108,y=cy+Math.sin(ang)*66,o=state.byId.get(r.other),lab=labelOf(o),t=lab.length>12?lab.slice(0,11)+'…':lab;g+=`<g class="mg-node" tabindex="0" role="button" data-target-id="${esc(r.other)}" aria-label="${esc(lab)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${schemaColor(o.schema)}"/><text x="${x.toFixed(1)}" y="${(y+(y>cy?22:-14)).toFixed(1)}" text-anchor="middle">${esc(t)}</text></g>`;});return `<svg class="mini-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="الكيانات المتصلة"><defs><marker id="mg-arrow" viewBox="0 0 8 8" refX="14" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs>${g}<circle cx="${cx}" cy="${cy}" r="14" fill="${schemaColor(c.schema)}" class="mg-center"/>${extra>0?`<text x="${W-8}" y="${H-6}" text-anchor="end" class="mg-more">+${extra}</text>`:''}</svg>`;}
  function showEdgeDetails(edge){
    const a=state.byId.get(nodeId(edge.source)),b=state.byId.get(nodeId(edge.target));if(!a||!b)return;
    $('#panel-title').textContent='تفاصيل العلاقة';$('#app-shell').classList.remove('panel-collapsed');$('#toggle-panel-btn').setAttribute('aria-expanded','true');$('#toggle-panel-btn').title='طي اللوحة';
    const fields=[['النوع',edge.type?typeAr(edge.type):''],['التسمية',edge.label],['الدور / التفاصيل',edge.role],['ملاحظات',edge.notes],['من تاريخ',edge.startDate||edge.start],['إلى تاريخ',edge.endDate||edge.end]].filter(([,v])=>v!==undefined&&v!==null&&String(v)!=='');
    $('#detail-content').innerHTML=`<div class="edge-head"><span class="entity-type">علاقة</span>${statusBadge(edge.status)}</div><h3 class="entity-title">${esc(edgeType(edge))}</h3><div class="edge-flow">${entityChip(a,nodeId(edge.source),'data-edge-end')}<div class="flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 40"><path d="M12 2v32M5 27l7 9 7-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>${entityChip(b,nodeId(edge.target),'data-edge-end')}</div><div class="detail-label">درجة الثقة</div>${confMeter(edge.confidence)}${fields.length?`<div class="detail-label">البيانات</div><dl class="attribute-list">${fields.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`:''}<div class="entity-actions"><button type="button" class="secondary-btn" id="edit-selected-edge">تعديل العلاقة</button><button type="button" class="secondary-btn" id="swap-edge-btn" title="عكس اتجاه العلاقة">⇅ عكس الاتجاه</button><button type="button" class="danger-btn" id="delete-selected-edge">حذف العلاقة</button></div>`;
    const dc=$('#detail-content');
    dc.querySelectorAll('[data-edge-end]').forEach(bt=>bt.addEventListener('click',()=>{const t=bt.getAttribute('data-edge-end');selectNode(t);centerOn(t)}));
    $('#edit-selected-edge').addEventListener('click',()=>editEdge(edge._key));$('#delete-selected-edge').addEventListener('click',()=>deleteEdge(edge._key));
    $('#swap-edge-btn').addEventListener('click',()=>swapEdge(edge._key));
  }
  function swapEdge(id){const e=state.data.edges.find(x=>nodeId(x.id)===id);if(!e)return;const s=e.source;e.source=e.target;e.target=s;refreshAfterMutation('تم عكس اتجاه العلاقة',nodeId(e.source));setTimeout(()=>{const ed=state.edges.find(x=>x._key===String(id));if(ed)selectEdge(ed._key);},0);}
  const fmtDate=d=>{if(!d)return '';const t=new Date(String(d)+'T00:00:00');return isNaN(t)?String(d):t.toLocaleDateString('ar',{year:'numeric',month:'long',day:'numeric'});};
  // Where an entity is "now": its own location text, else the newest active Located_At link to an address.
  function placeCard(n,rels){
    const links=rels.filter(r=>r.edge.type==='Located_At'&&state.byId.get(r.other)?.schema==='Address');
    const live=links.filter(r=>r.edge.status!=='inactive'),pool=live.length?live:links;
    const cur=pool.reduce((best,r)=>!best||String(r.edge.date||'')>=String(best.edge.date||'')?r:best,null);
    const isEvent=n.schema==='Event',title=isEvent?'مكان الحدث':'الموقع الحالي';
    const text=n.location||(cur?labelOf(state.byId.get(cur.other)):'');
    const pin='<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/></svg>';
    if(n.schema==='Address')return '';
    const others=links.filter(r=>r!==cur);
    const body=text?`<div class="place-main">${n.location&&cur?`<b>${esc(n.location)}</b><button type="button" class="place-link" data-target-id="${esc(cur.other)}">${esc(labelOf(state.byId.get(cur.other)))}</button>`:cur&&!n.location?`<button type="button" class="place-link big" data-target-id="${esc(cur.other)}">${esc(text)}</button>`:`<b>${esc(text)}</b>`}</div>${cur&&(cur.edge.date||cur.edge.role)?`<small class="place-sub">${cur.edge.date?'منذ '+esc(fmtDate(cur.edge.date)):''}${cur.edge.date&&cur.edge.role?' · ':''}${esc(cur.edge.role||'')}</small>`:''}${isEvent&&n.date?`<small class="place-sub">التاريخ: ${esc(fmtDate(n.date))}</small>`:''}${others.length?`<div class="place-others"><span>مواقع أخرى:</span>${others.map(r=>`<button type="button" class="chip-btn" data-target-id="${esc(r.other)}">${esc(labelOf(state.byId.get(r.other)))}</button>`).join('')}</div>`:''}`:`<p class="empty-note">لم يُحدَّد موقع. أضفه من «تعديل الكيان» أو اربطه بعنوان.</p>`;
    return `<section class="info-card place-card"><h4>${pin}<span>${title}</span></h4>${body}</section>`;
  }
  // Events this entity took part in, oldest first (undated ones keep their order after the dated ones).
  function eventTimeline(id,n,rels){
    if(n.schema==='Event')return '';
    const items=rels.map((r,i)=>({r,i,t:state.byId.get(r.other)})).filter(x=>x.t?.schema==='Event').map(x=>({...x,date:x.r.edge.date||x.t.date||''}));
    if(!items.length)return '';
    items.sort((a,b)=>(a.date&&b.date)?String(a.date).localeCompare(String(b.date))||a.i-b.i:a.date?-1:b.date?1:a.i-b.i);
    const placeOf=t=>{const l=(state.adjacency.get(nodeId(t.id))||[]).find(q=>q.edge.type==='Located_At'&&state.byId.get(q.other)?.schema==='Address');return l?labelOf(state.byId.get(l.other)):(t.location||'');};
    return `<section class="info-card"><h4><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>تسلسل الأحداث</span><b>${items.length}</b></h4><ol class="timeline">${items.map((it,k)=>{const pl=placeOf(it.t),meta=[it.r.edge.role||it.r.edge.label,pl].filter(Boolean).join(' · ');return `<li><span class="tl-dot">${k+1}</span><button type="button" class="tl-body" data-target-id="${esc(it.r.other)}"><span class="tl-date${it.date?'':' none'}">${it.date?esc(fmtDate(it.date)):'بدون تاريخ'}</span><strong>${esc(labelOf(it.t))}</strong>${meta?`<small>${esc(meta)}</small>`:''}</button></li>`;}).join('')}</ol></section>`;
  }
  function showDetails(id){const n=state.byId.get(id);if(!n)return;$('#panel-title').textContent='تفاصيل الكيان';const rels=(state.adjacency.get(id)||[]).filter(r=>state.byId.get(r.other));const schema=TYPE_AR[n.schema]||n.schema||'كيان';const col=schemaColor(n.schema);
    const out=rels.filter(r=>nodeId(r.edge.source)===id).length,inc=rels.length-out;
    const photo=n.photo?`<img class="entity-photo" src="${esc(n.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:`<span class="entity-avatar" style="background:${col}" aria-hidden="true">${esc([...labelOf(n)][0]||'•')}</span>`;
    const summary=n.summary?`<p class="entity-summary">${esc(n.summary)}</p>`:'';
    const url=n.url&&/^https?:\/\//i.test(String(n.url).trim())?`<p><a href="${esc(String(n.url).trim())}" target="_blank" rel="noopener noreferrer" style="color:var(--lime);font-size:12px">فتح المصدر ↗</a></p>`:'';
    const groups=new Map();rels.forEach(r=>{const k=String(r.edge.label||r.edge.type||'علاقة');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);});
    const relCard=({edge,other})=>{const t=state.byId.get(other),isOut=nodeId(edge.source)===id;return `<div class="relation-row-wrap"><button class="relation-row" data-target-id="${esc(other)}"><span class="relation-type dir" title="${isOut?'صادرة':'واردة'}">${isOut?'←':'→'}</span><span class="rel-main"><span class="relation-name">${esc(labelOf(t))}</span><span class="relation-meta">${esc(TYPE_AR[t.schema]||t.schema||'كيان')}${edge.role?' · '+esc(edge.role):''}</span>${confMeter(edge.confidence)}</span>${statusBadge(edge.status)}</button><span class="relation-actions"><button type="button" data-edit-edge="${esc(edge._key)}" title="تعديل العلاقة" aria-label="تعديل العلاقة">✎</button><button type="button" data-delete-edge="${esc(edge._key)}" title="حذف العلاقة" aria-label="حذف العلاقة">×</button></span></div>`;};
    const relHtml=[...groups.entries()].map(([k,list])=>`<section class="rel-group"><h4><span>${esc(k)}</span><b>${list.length}</b></h4><div class="relation-list">${list.map(relCard).join('')}</div></section>`).join('');
    const info=[['الدولة / النطاق',countryAr(n.country)],['الشكل القانوني',n.legalForm],['كيان حدودي',n.boundary!==undefined?(n.boundary?'نعم':'لا'):undefined],['الموضوعات المرتبطة',Array.isArray(n.subjects)&&n.subjects.filter(v=>typeof v==='string'&&v&&!/^\d+$/.test(v)).length?n.subjects.filter(v=>typeof v==='string'&&v&&!/^\d+$/.test(v)).join('، '):undefined]].filter(([,v])=>v!==undefined&&v!==null&&String(v)!=='');
    const attrs=n.attributes&&typeof n.attributes==='object'?Object.entries(n.attributes):[];
    const details=(info.length||attrs.length)?`<dl class="attribute-list">${info.concat(attrs.map(([k,v])=>[attrKeyAr(k),typeof v==='object'?JSON.stringify(v):v])).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${url}`:`<p class="empty-note">لا توجد بيانات إضافية.</p>${url}`;
    const isEv=n.schema==='Event'&&!!window.RelationshipEvents;
    const evPanel=(!isEv&&window.RelationshipEvents)?window.RelationshipEvents.entityPanel(id):{count:0,html:''};
    const locPanel=window.RelationshipMap?window.RelationshipMap.locationPanel(id):{has:false,html:''};
    if(isEv&&!['relations','details','overview','profile-personal','profile-family','profile-health'].includes(state.panelTab))state.panelTab='event';
    $('#detail-content').innerHTML=`<div class="entity-card" style="--c:${col}">${photo}<div class="entity-card-text"><span class="entity-type"><i class="legend-dot" style="background:${col};margin-left:7px"></i>${esc(schema)}</span><h3 class="entity-title">${esc(labelOf(n))}</h3>${countryAr(n.country)?`<span class="entity-sub">${esc(countryAr(n.country))}</span>`:''}</div>${statusBadge(n.status)}</div><div class="stat-grid stat-grid-3"><div class="stat"><strong>${rels.length}</strong><span>الاتصالات</span></div><div class="stat"><strong>${out}</strong><span>صادرة</span></div><div class="stat"><strong>${inc}</strong><span>واردة</span></div></div><div class="entity-actions"><button type="button" class="secondary-btn" id="edit-entity-btn">تعديل الكيان</button><button type="button" class="secondary-btn" id="add-related-edge-btn">＋ علاقة</button>${locPanel.has?'<button type="button" class="secondary-btn" data-geo-jump>على الخريطة</button>':''}<button type="button" class="danger-btn" id="delete-entity-btn">حذف الكيان</button></div><div class="tabs" role="tablist" aria-label="أقسام التفاصيل">${isEv?'<button type="button" role="tab" data-tab="event">الحدث</button>':''}<button type="button" role="tab" data-tab="overview">نظرة عامة</button>${window.RelationshipProfileUI?.tabButtons(n)||''}${isEv?'':`<button type="button" role="tab" data-tab="events">الأحداث <b>${evPanel.count}</b></button>`}${locPanel.html?`<button type="button" role="tab" data-tab="location">الموقع${locPanel.has?' <b>●</b>':''}</button>`:''}<button type="button" role="tab" data-tab="relations">العلاقات <b>${rels.length}</b></button><button type="button" role="tab" data-tab="details">البيانات</button></div>${isEv?`<div role="tabpanel" data-panel="event">${window.RelationshipEvents?window.RelationshipEvents.eventPanel(id):''}</div>`:`<div role="tabpanel" data-panel="events" hidden>${evPanel.html}</div>`}<div role="tabpanel" data-panel="overview">${summary}${window.RelationshipProfileUI?.summary(n)||''}${placeCard(n,rels)}${miniGraph(id,rels)||'<p class="empty-note">لا توجد علاقات لعرضها.</p>'}</div>${window.RelationshipProfileUI?.panels(n)||''}${locPanel.html?`<div role="tabpanel" data-panel="location" hidden>${locPanel.html}</div>`:''}<div role="tabpanel" data-panel="relations" hidden>${relHtml||'<p class="empty-note">لا توجد علاقات متاحة.</p>'}</div><div role="tabpanel" data-panel="details" hidden>${details}</div>`;
    const dc=$('#detail-content');
    wireTabs(dc);
    window.RelationshipEvents?.wirePanel(dc,id);
    window.RelationshipProfileUI?.wirePanel(dc,id);
    window.RelationshipMap?.wirePanel(dc,id);
    dc.querySelectorAll('[data-target-id]').forEach(b=>{const go=()=>{const next=b.getAttribute('data-target-id');selectNode(next);centerOn(next)};b.addEventListener('click',go);if(b.tagName==='g')b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});});
    $('#edit-entity-btn')?.addEventListener('click',()=>editEntity(id));
    $('#delete-entity-btn')?.addEventListener('click',()=>deleteEntity(id));
    $('#add-related-edge-btn')?.addEventListener('click',addEdge);
    dc.querySelectorAll('[data-edit-edge]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();editEdge(b.getAttribute('data-edit-edge'))}));
    dc.querySelectorAll('[data-delete-edge]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();deleteEdge(b.getAttribute('data-delete-edge'))}));
  }
  function hideContextToolbar(){const bar=$('#node-context-toolbar');if(bar)bar.hidden=true;}
  function positionContextToolbar(id){
    const bar=$('#node-context-toolbar'),node=state.byId.get(String(id)),p=state.positions.get(String(id));if(!bar||!node||!p||!node._el)return;
    const frame=$('#map-frame'),fr=frame.getBoundingClientRect(),pt=svg.createSVGPoint();pt.x=p.x;pt.y=p.y;const matrix=viewport.getScreenCTM();if(!matrix)return;const screen=pt.matrixTransform(matrix);
    const radius=getRadius(node),barWidth=88,barHeight=42;
    // Anchor the two action buttons beside the relationship-count badge at the node's upper-right rim.
    const desiredLeft=screen.x-fr.left+radius*.7+10,desiredTop=screen.y-fr.top-radius*.7-barHeight/2;
    const left=Math.max(8,Math.min(fr.width-barWidth-8,desiredLeft)),top=Math.max(44,Math.min(fr.height-barHeight-8,desiredTop));
    bar.style.left=`${left}px`;bar.style.top=`${top}px`;bar.hidden=false;
  }
  $('#node-context-toolbar').addEventListener('pointerenter',()=>{if(state.hoverTimer){clearTimeout(state.hoverTimer);state.hoverTimer=null;}});
  $('#node-context-toolbar').addEventListener('pointerleave',()=>{if(!state.selected){state.hovered=null;applyFilters();hideContextToolbar();}});
  $('#node-context-toolbar').addEventListener('click',e=>{if(Date.now()<(state.linkSuppressClickUntil||0))return;const btn=e.target.closest('[data-node-action]');if(!btn)return;const id=state.selected||state.hovered;if(!id||!state.byId.has(id))return;switch(btn.dataset.nodeAction){case 'edit':selectNode(id);editEntity(id);break;case 'edge':selectNode(id);addEdge();break;}});
  // ---- Drag-to-link: drag the "new relationship" button from a node onto another node ----
  // A plain click on the button still opens the form; dragging it creates the relationship directly.
  const linkLayer=svgEl('g',{id:'link-layer','pointer-events':'none'});viewport.append(linkLayer);
  {const defs=svgEl('defs'),m=svgEl('marker',{id:'arrow-link',markerWidth:9,markerHeight:9,refX:7,refY:4.5,orient:'auto',markerUnits:'userSpaceOnUse'});m.append(svgEl('path',{d:'M0,0 L9,4.5 L0,9 z',fill:'#CDFE64'}));defs.append(m);viewport.append(defs);}
  function pointerToGraph(e){const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const m=viewport.getScreenCTM();return m?pt.matrixTransform(m.inverse()):{x:0,y:0};}
  function nodeAtPoint(x,y){const el=document.elementFromPoint(x,y);const g=el&&el.closest?el.closest('.node'):null;return g?g.getAttribute('data-id'):null;}
  function clearLinkPreview(){linkLayer.replaceChildren();document.querySelectorAll('.node.link-target').forEach(n=>n.classList.remove('link-target'));document.body.classList.remove('is-linking');applyFilters();}
  function cancelLink(message){const l=state.linking;if(!l)return;state.linking=null;try{l.button.releasePointerCapture(l.pointerId)}catch(_){/* already released */}if(l.moved)state.linkSuppressClickUntil=Date.now()+400;clearLinkPreview();if(message)setStatus(message);}
  function createLink(sourceId,targetId){
    const dup=state.edges.find(x=>nodeId(x.source)===sourceId&&nodeId(x.target)===targetId);
    if(dup){selectEdge(dup._key);setStatus('هذه العلاقة موجودة مسبقًا');return;}
    const e={id:nextId(state.data.edges),source:coerceId(sourceId),target:coerceId(targetId),type:'Associate',label:'ارتباط',role:'',confidence:70,status:'active'};
    state.data.edges.push(e);
    refreshAfterMutation(`تم ربط «${labelOf(state.byId.get(sourceId))}» بـ «${labelOf(state.byId.get(targetId))}» · Ctrl+Z للتراجع`,sourceId,{keepView:true});
    const created=state.edges.find(x=>String(x.id)===String(e.id));if(created)selectEdge(created._key);
  }
  $('#node-context-toolbar').addEventListener('pointerdown',e=>{
    const btn=e.target.closest('[data-node-action="edge"]');if(!btn||e.button!==0)return;
    const id=state.selected||state.hovered;if(!id||!state.byId.has(id))return;
    state.linking={sourceId:id,button:btn,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,moved:false,targetId:null};
    try{btn.setPointerCapture(e.pointerId)}catch(_){/* capture is optional */}
  });
  window.addEventListener('pointermove',e=>{
    const l=state.linking;if(!l||e.pointerId!==l.pointerId)return;
    if(!l.moved){if(Math.hypot(e.clientX-l.startX,e.clientY-l.startY)<6)return;l.moved=true;document.body.classList.add('is-linking');applyFilters();setStatus('اسحب إلى الكيان المراد ربطه · Esc للإلغاء');}
    const src=state.positions.get(l.sourceId);if(!src)return;
    const target=nodeAtPoint(e.clientX,e.clientY);
    const valid=target&&target!==l.sourceId&&state.byId.has(target)?target:null;
    if(valid!==l.targetId){document.querySelectorAll('.node.link-target').forEach(n=>n.classList.remove('link-target'));if(valid)state.byId.get(valid)._el?.classList.add('link-target');l.targetId=valid;}
    const end=valid?state.positions.get(valid):pointerToGraph(e);
    let path=linkLayer.firstChild;if(!path){path=svgEl('path',{class:'link-preview','marker-end':'url(#arrow-link)'});linkLayer.append(path);}
    path.setAttribute('d',`M ${src.x} ${src.y} L ${end.x} ${end.y}`);path.classList.toggle('snapped',!!valid);
  });
  window.addEventListener('pointerup',e=>{
    const l=state.linking;if(!l||e.pointerId!==l.pointerId)return;
    state.linking=null;try{l.button.releasePointerCapture(l.pointerId)}catch(_){/* already released */}
    const target=l.moved?nodeAtPoint(e.clientX,e.clientY):null;
    clearLinkPreview();
    if(!l.moved)return;
    state.linkSuppressClickUntil=Date.now()+400;
    if(!target||!state.byId.has(target)){setStatus('أُلغي الربط · أفلت المؤشر فوق كيان آخر لإنشاء العلاقة');return;}
    if(target===l.sourceId){setStatus('لا يمكن ربط الكيان بنفسه');return;}
    createLink(l.sourceId,target);
  });
  window.addEventListener('pointercancel',()=>cancelLink('أُلغي الربط'));
  $('#focus-mode-btn').addEventListener('click',()=>{const active=$('#app-shell').classList.toggle('focus-mode');$('#focus-mode-btn').setAttribute('aria-pressed',String(active));$('#focus-mode-btn').title=active?'إنهاء وضع العرض الواسع':'وضع العرض الواسع';requestAnimationFrame(()=>{if(state.selected)positionContextToolbar(state.selected);});});
  $('#toggle-panel-btn').addEventListener('click',()=>{const shell=$('#app-shell'),collapsed=shell.classList.toggle('panel-collapsed');$('#toggle-panel-btn').setAttribute('aria-expanded',String(!collapsed));$('#toggle-panel-btn').title=collapsed?'إظهار اللوحة':'طي اللوحة';});
  function centerOn(id){const p=state.positions.get(id);if(!p)return;state.scale=Math.max(state.scale,1.1);state.tx=600-p.x*state.scale;state.ty=380-p.y*state.scale;applyTransform()}
  function autoLayoutEnabled(){return $('#autosave-layout-switch')?.checked!==false;}
  function saveAutoLayoutState(){
    if(!autoLayoutEnabled())return;
    try{
      const payload={version:1,savedAt:new Date().toISOString(),layout:state.layout,positions:Object.fromEntries([...state.positions].map(([id,p])=>[id,{x:p.x,y:p.y}])),scale:state.scale,tx:state.tx,ty:state.ty};
      localStorage.setItem(AUTO_LAYOUT_KEY,JSON.stringify(payload));
    }catch(err){setStatus('تعذر حفظ ترتيب الخريطة تلقائيًا في هذا المتصفح',false);console.warn('Auto layout save failed',err);}
    scheduleDbLayoutSave();
  }
  // The arrangement also goes to the database (when connected) so it follows the data across browsers/devices.
  function layoutPayload(){return{layout:state.layout,positions:Object.fromEntries([...state.positions].map(([id,p])=>[id,{x:p.x,y:p.y}])),scale:state.scale,tx:state.tx,ty:state.ty};}
  function scheduleDbLayoutSave(){if(dbMode!=='db'||!layoutQueue||!autoLayoutEnabled())return;layoutQueue.schedule(JSON.stringify(layoutPayload()));}
  function scheduleAutoLayoutSave(){if(!autoLayoutEnabled())return;if(autoLayoutTimer)clearTimeout(autoLayoutTimer);autoLayoutTimer=setTimeout(saveAutoLayoutState,220);}
  function restoreAutoLayoutState(remoteLayout){
    const enabled=$('#autosave-layout-switch');
    try{const setting=localStorage.getItem(AUTO_LAYOUT_ENABLED_KEY);if(enabled)enabled.checked=setting===null?true:setting==='true';}catch(_){if(enabled)enabled.checked=true;}
    if(!autoLayoutEnabled())return false;
    try{
      let saved=remoteLayout;
      if(!saved){const raw=localStorage.getItem(AUTO_LAYOUT_KEY);if(!raw)return false;saved=JSON.parse(raw);}
      if(!saved||saved.version!==1||!saved.positions||typeof saved.positions!=='object')return false;
      if(['grouped','concentric','classic'].includes(saved.layout)){state.layout=saved.layout;$('#layout-select').value=state.layout;}
      layout();let restored=0;
      for(const [id,pos] of Object.entries(saved.positions)){if(state.positions.has(id)&&Number.isFinite(pos?.x)&&Number.isFinite(pos?.y)){state.positions.set(id,{x:pos.x,y:pos.y});restored++;}}
      if(!restored)return false;
      if(Number.isFinite(saved.scale))state.scale=Math.max(.28,Math.min(3.5,saved.scale));
      if(Number.isFinite(saved.tx))state.tx=saved.tx;if(Number.isFinite(saved.ty))state.ty=saved.ty;
      render();applyTransform();setStatus(`استُعيد ترتيب الخريطة تلقائيًا (${restored} عقد)`);return true;
    }catch(err){console.warn('Auto layout restore failed',err);setStatus('تعذر استعادة ترتيب الخريطة المحفوظ',false);return false;}
  }
  function applyTransform(){viewport.setAttribute('transform',`translate(${state.tx} ${state.ty}) scale(${state.scale})`);scheduleLabelLayout();if(state.selected)positionContextToolbar(state.selected);else if(state.hovered)positionContextToolbar(state.hovered);drawMinimap();scheduleAutoLayoutSave();}
  // ---- Label declutter -------------------------------------------------------------------
  // Labels keep a constant on-screen size and are placed greedily by importance; a label that
  // would overlap an already placed label (or another node) is hidden. Zooming in makes room,
  // so more labels appear. Hover/selection raise a node's priority so its label is always shown.
  const LABEL_PX=12, EDGE_LABEL_PX=10;
  let labelRaf=0;
  function scheduleLabelLayout(){if(labelRaf)return;labelRaf=requestAnimationFrame(()=>{labelRaf=0;layoutLabels();});}
  function labelHalfWidth(text,px){let w=0;for(const ch of text)w+=/[؀-ۿ]/.test(ch)?.5:(/[A-Z0-9]/.test(ch)?.66:.56);return Math.max(8,w*px/2);}
  function layoutLabels(){
    const ctm=svg.getScreenCTM();if(!ctm||!state.positions.size)return;
    const k=ctm.a||1,sc=state.scale*k;
    const focusId=state.hovered||state.selected;
    const near=focusId?new Set([focusId,...(state.adjacency.get(focusId)||[]).map(x=>typeof x==='object'?x.other:x)]):new Set();
    const placed=[];const hit=(b,own)=>placed.some(o=>o.id!==own&&b.x1<o.x2+4&&b.x2+4>o.x1&&b.y1<o.y2+2&&b.y2+2>o.y1);
    const nodeItems=[],obstacles=[];
    for(const n of state.nodes){
      const id=nodeId(n.id),p=state.positions.get(id);if(!p||!n._el)continue;
      const lab=n._el.querySelector('.node-label');if(!lab)continue;
      const r=getRadius(n),cx=(p.x*state.scale+state.tx)*k,cy=(p.y*state.scale+state.ty)*k,rr=r*sc;
      obstacles.push({id,x1:cx-rr,x2:cx+rr,y1:cy-rr,y2:cy+rr});
      const deg=(state.adjacency.get(id)||[]).length;
      const pri=(id===focusId?1e6:0)+(id===state.selected?1e6:0)+(state.matchIds.has(id)&&state.search.trim()?5e5:0)+(near.has(id)?1e5:0)+deg;
      const role=n._el.querySelector('.profile-role-label'),half=Math.max(labelHalfWidth(lab.textContent,LABEL_PX),role?labelHalfWidth(role.textContent,LABEL_PX):0),top=cy+rr+3;
      nodeItems.push({lab,role,id,pri,r,box:{x1:cx-half,x2:cx+half,y1:top,y2:top+LABEL_PX*(role?2:1)+2}});
    }
    nodeItems.sort((a,b)=>b.pri-a.pri);
    for(const o of obstacles)placed.push(o);               // node discs are obstacles for labels
    for(const it of nodeItems){
      const show=it.pri>=1e6||!hit(it.box,it.id);           // a node never blocks its own label
      if(show)placed.push({x1:it.box.x1,x2:it.box.x2,y1:it.box.y1,y2:it.box.y2});
      it.lab.style.fontSize=(LABEL_PX/sc)+'px';it.lab.setAttribute('y',it.r+(LABEL_PX+5)/sc);
      it.lab.style.strokeWidth=(3.5/sc)+'px';
      if(show)it.lab.removeAttribute('display');else it.lab.setAttribute('display','none');
      if(it.role){it.role.style.fontSize=(LABEL_PX/sc)+'px';it.role.style.strokeWidth=(3.5/sc)+'px';it.role.setAttribute('y',it.r+(2*LABEL_PX+8)/sc);if(show)it.role.removeAttribute('display');else it.role.setAttribute('display','none');}
    }
    const edgeItems=[];
    for(const e of state.edges){
      const lab=e._label;if(!lab||!e._group||!e._group.isConnected)continue;
      const mx=+lab.getAttribute('x'),my=+lab.getAttribute('y');
      const cx=(mx*state.scale+state.tx)*k,cy=(my*state.scale+state.ty)*k,half=labelHalfWidth(lab.textContent,EDGE_LABEL_PX);
      const touches=focusId&&(nodeId(e.source)===focusId||nodeId(e.target)===focusId);
      edgeItems.push({lab,pri:(state.selectedEdgeKey===e._key?2e6:0)+(touches?1e5:0),box:{x1:cx-half,x2:cx+half,y1:cy-EDGE_LABEL_PX,y2:cy+2}});
    }
    edgeItems.sort((a,b)=>b.pri-a.pri);
    for(const it of edgeItems){
      const show=it.pri>=2e6||!hit(it.box,null);
      if(show)placed.push(it.box);
      it.lab.style.fontSize=(EDGE_LABEL_PX/sc)+'px';it.lab.style.strokeWidth=(4/sc)+'px';
      if(show)it.lab.removeAttribute('display');else it.lab.setAttribute('display','none');
    }
  }
  function fitView(){if(!state.positions.size)return;const vals=[...state.positions.values()],xs=vals.map(p=>p.x),ys=vals.map(p=>p.y);const minX=Math.min(...xs)-100,maxX=Math.max(...xs)+100,minY=Math.min(...ys)-100,maxY=Math.max(...ys)+100;const w=Math.max(300,maxX-minX),h=Math.max(250,maxY-minY);state.scale=Math.min(1,Math.min(1120/w,680/h));state.tx=600-(minX+maxX)/2*state.scale;state.ty=380-(minY+maxY)/2*state.scale;applyTransform()}
  function zoom(factor,px=600,py=380){const old=state.scale;state.scale=Math.max(.28,Math.min(3.5,old*factor));const ratio=state.scale/old;state.tx=px-(px-state.tx)*ratio;state.ty=py-(py-state.ty)*ratio;applyTransform()}
  function updateConnectedEdges(id){
    for(const e of state.edges){
      const a=nodeId(e.source),b=nodeId(e.target);
      if(a!==id&&b!==id)continue;
      const p1=state.positions.get(a),p2=state.positions.get(b);if(!p1||!p2)continue;
      const dx=p2.x-p1.x,dy=p2.y-p1.y,dist=Math.hypot(dx,dy)||1;
      const bend=Math.min(45,dist*.13)*(String(e.id).length%2?1:-1);
      const mx=(p1.x+p2.x)/2-dy/dist*bend,my=(p1.y+p2.y)/2+dx/dist*bend;
      const d=`M ${p1.x} ${p1.y} Q ${mx} ${my} ${p2.x} ${p2.y}`;
      e._path?.setAttribute('d',d);
      e._group?.querySelector('.edge-hit')?.setAttribute('d',d);
      if(e._label){e._label.setAttribute('x',mx);e._label.setAttribute('y',my-4);}
    }
  }
  function startNodeDrag(e,id,element){
    if(e.button!==0||state.lockNodes)return;
    e.stopPropagation();
    state.suppressClickId=null;
    state.dragging={id,startX:e.clientX,startY:e.clientY,orig:{...state.positions.get(id)},moved:false,active:false,pointerId:e.pointerId};
    try{element.setPointerCapture(e.pointerId)}catch(_){/* Pointer capture is optional in older browsers. */}
  }
  svg.addEventListener('pointerdown',e=>{
    if(e.target.closest('.node'))return;
    state.panning={x:e.clientX,y:e.clientY,tx:state.tx,ty:state.ty,pointerId:e.pointerId,onEdge:!!e.target.closest('.edge,.edge-hit,.edge-label')};
  });
  svg.addEventListener('pointermove',e=>{
    if(state.dragging){
      const drag=state.dragging;
      const clientDx=e.clientX-drag.startX,clientDy=e.clientY-drag.startY;
      // A node only starts moving after a deliberate drag threshold; a normal click remains a click.
      if(!drag.active && Math.hypot(clientDx,clientDy)>=5){drag.active=true;drag.moved=true;}
      if(drag.active){
        const rect=svg.getBoundingClientRect(),dx=clientDx*1200/rect.width/state.scale,dy=clientDy*760/rect.height/state.scale;
        const p=state.positions.get(drag.id);p.x=drag.orig.x+dx;p.y=drag.orig.y+dy;
        const node=state.byId.get(drag.id);if(node?._el)node._el.setAttribute('transform',`translate(${p.x} ${p.y})`);
        updateConnectedEdges(drag.id);
      }
    } else if(state.panning){
      state.tx=state.panning.tx+(e.clientX-state.panning.x)*1200/svg.getBoundingClientRect().width;
      state.ty=state.panning.ty+(e.clientY-state.panning.y)*760/svg.getBoundingClientRect().height;
      applyTransform();
    }
  });
  // A plain click on empty map space closes the open menus. The details panel and the selection stay as they are.
  function dismissUI(){
    $('#advanced-tools')?.removeAttribute('open');const help=$('#shortcuts-help');if(help)help.hidden=true;
    if(!uiPrefs.hidePanel)return;
    if(state.selected||state.selectedEdgeKey){state.selected=null;state.selectedEdgeKey=null;hideContextToolbar();applyFilters();}
    const shell=$('#app-shell');if(!shell.classList.contains('panel-collapsed')){shell.classList.add('panel-collapsed');$('#toggle-panel-btn').setAttribute('aria-expanded','false');$('#toggle-panel-btn').title='إظهار اللوحة';}
    $('#panel-title').textContent='تفاصيل الكيان';$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>';
  }
  function finishPointer(){
    let layoutChanged=false;
    if(state.dragging){
      if(state.dragging.moved){state.suppressClickId=state.dragging.id;state.suppressClickAt=Date.now();selectNode(state.dragging.id);layoutChanged=true;}
      state.dragging=null;
    }
    if(state.panning&&(state.tx!==state.panning.tx||state.ty!==state.panning.ty))layoutChanged=true;
    const cleanMapClick=!!state.panning&&!state.panning.onEdge&&!layoutChanged&&!(state.linking&&state.linking.moved);
    state.panning=null;
    if(cleanMapClick)dismissUI();
    if(layoutChanged){saveAutoLayoutState();scheduleLabelLayout();}
  }
  window.addEventListener('pointerup',finishPointer);
  window.addEventListener('pointercancel',finishPointer);
  svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect(),px=(e.clientX-r.left)*1200/r.width,py=(e.clientY-r.top)*760/r.height;zoom(e.deltaY<0?1.12:.89,px,py)},{passive:false});
  // ---- Search suggestions (styled list instead of the browser's plain datalist) ----
  let suggestItems=[],suggestIdx=-1;
  function highlight(text,q){const t=String(text),i=t.toLocaleLowerCase().indexOf(q);return i<0?esc(t):esc(t.slice(0,i))+'<mark>'+esc(t.slice(i,i+q.length))+'</mark>'+esc(t.slice(i+q.length));}
  function searchMatches(raw){
    const q=raw.trim().toLocaleLowerCase();if(!q)return[];
    const out=[];
    for(const n of state.nodes){
      const name=labelOf(n).toLocaleLowerCase();let score;
      if(name.startsWith(q))score=0;else if(name.includes(q))score=1;
      else if([n.labelEn,n.summary,n.country,n.url,n.id].filter(Boolean).join(' ').toLocaleLowerCase().includes(q))score=2;else continue;
      out.push({n,score});
    }
    return out.sort((a,b)=>a.score-b.score||labelOf(a.n).localeCompare(labelOf(b.n),'ar')).slice(0,8).map(x=>x.n);
  }
  function hideSuggest(){const box=$('#search-suggest');if(box){box.hidden=true;box.innerHTML='';}$('#search').setAttribute('aria-expanded','false');suggestItems=[];suggestIdx=-1;}
  function renderSuggest(){
    const box=$('#search-suggest'),raw=$('#search').value;if(!box)return;
    if(!raw.trim()){hideSuggest();return;}
    suggestItems=searchMatches(raw);suggestIdx=-1;
    const q=raw.trim().toLocaleLowerCase();
    box.innerHTML=suggestItems.length?suggestItems.map((n,i)=>{const deg=(state.adjacency.get(nodeId(n.id))||[]).length,rel=deg===0?'بلا علاقات':deg===1?'علاقة واحدة':deg===2?'علاقتان':deg<=10?`${deg} علاقات`:`${deg} علاقة`;return `<div class="suggest-item" role="option" id="sg-${i}" data-i="${i}"><i class="legend-dot" style="background:${schemaColor(n.schema)}"></i><span class="sg-main"><b>${highlight(labelOf(n),q)}</b><small>${esc(TYPE_AR[n.schema]||n.schema||'كيان')} · ${rel}</small></span></div>`;}).join(''):'<div class="suggest-empty">لا توجد نتائج مطابقة</div>';
    box.hidden=false;$('#search').setAttribute('aria-expanded','true');
  }
  function paintSuggest(){const box=$('#search-suggest');box.querySelectorAll('.suggest-item').forEach((el,i)=>{const on=i===suggestIdx;el.classList.toggle('active',on);el.setAttribute('aria-selected',String(on));if(on){el.scrollIntoView({block:'nearest'});$('#search').setAttribute('aria-activedescendant',el.id);}});}
  function chooseSuggest(i){const n=suggestItems[i];if(!n)return false;const id=nodeId(n.id);$('#search').value=labelOf(n);state.search=labelOf(n);hideSuggest();applyFilters();selectNode(id);centerOn(id);return true;}
  // Returns true when the key was used by the suggestion list.
  function searchSuggestKey(e){
    const box=$('#search-suggest');if(!box||box.hidden)return false;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(!suggestItems.length)return true;e.preventDefault();suggestIdx=(suggestIdx+(e.key==='ArrowDown'?1:-1)+suggestItems.length)%suggestItems.length;paintSuggest();return true;}
    if(e.key==='Enter'&&suggestIdx>=0){e.preventDefault();return chooseSuggest(suggestIdx);}
    if(e.key==='Escape'){e.preventDefault();hideSuggest();return true;}
    return false;
  }
  (function wireSuggest(){
    const box=$('#search-suggest'),input=$('#search');if(!box)return;
    box.addEventListener('pointerdown',e=>{const it=e.target.closest('.suggest-item');if(!it)return;e.preventDefault();chooseSuggest(Number(it.dataset.i));});
    box.addEventListener('pointermove',e=>{const it=e.target.closest('.suggest-item');if(it&&Number(it.dataset.i)!==suggestIdx){suggestIdx=Number(it.dataset.i);paintSuggest();}});
    input.addEventListener('focus',renderSuggest);
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('.search-box'))hideSuggest();},true);
  })();
  // ---- Styled dropdown for every <select> (native pickers look out of place in the dark theme) ----
  (function styledSelects(){
    let list=null,sel=null,idx=-1;
    const enabled=i=>sel&&sel.options[i]&&!sel.options[i].disabled;
    function close(refocus){if(list){list.remove();list=null;}if(sel){sel.classList.remove('dd-open');sel.setAttribute('aria-expanded','false');if(refocus)sel.focus();}sel=null;idx=-1;}
    function paint(){if(!list)return;list.querySelectorAll('.dd-item').forEach((el,i)=>{el.classList.toggle('active',i===idx);if(i===idx)el.scrollIntoView({block:'nearest'});});}
    function place(){
      const r=sel.getBoundingClientRect(),w=Math.max(r.width,170),gap=6,room=window.innerHeight;
      const below=room-r.bottom-12,above=r.top-12,openUp=below<180&&above>below,maxH=Math.max(120,Math.min(300,openUp?above:below));
      list.style.minWidth=w+'px';list.style.maxHeight=maxH+'px';
      list.style.left=Math.min(Math.max(8,r.right-Math.max(w,list.offsetWidth)),window.innerWidth-Math.max(w,list.offsetWidth)-8)+'px';
      list.style.top=openUp?'':(r.bottom+gap)+'px';list.style.bottom=openUp?(room-r.top+gap)+'px':'';
    }
    function open(select){
      close();sel=select;idx=select.selectedIndex;
      list=document.createElement('div');list.className='dd-list';list.setAttribute('role','listbox');
      list.innerHTML=[...select.options].map((o,i)=>`<div class="dd-item${o.disabled?' disabled':''}" role="option" data-i="${i}" aria-selected="${i===select.selectedIndex}"><span>${esc(o.textContent)}</span><i class="dd-check" aria-hidden="true">✓</i></div>`).join('');
      document.body.append(list);place();select.classList.add('dd-open');select.setAttribute('aria-expanded','true');paint();
    }
    function choose(i){if(!enabled(i))return;const select=sel;select.selectedIndex=i;close(true);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
    const custom=t=>t&&t.tagName==='SELECT'&&!t.multiple&&!(t.size>1)&&!t.disabled;
    document.addEventListener('mousedown',e=>{
      if(list&&list.contains(e.target)){e.preventDefault();return;}
      if(custom(e.target)){e.preventDefault();e.target.focus();if(sel===e.target)close();else open(e.target);}
      else if(list)close();
    },true);
    document.addEventListener('click',e=>{if(!list)return;const it=e.target.closest('.dd-item');if(it&&list.contains(it))choose(Number(it.dataset.i));},true);
    document.addEventListener('mouseover',e=>{const it=list&&e.target.closest('.dd-item');if(it&&enabled(Number(it.dataset.i))){idx=Number(it.dataset.i);paint();}});
    document.addEventListener('keydown',e=>{
      if(list){
        const n=sel.options.length;let handled=true;
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){const d=e.key==='ArrowDown'?1:-1;let i=idx;for(let k=0;k<n;k++){i=(i+d+n)%n;if(enabled(i))break;}idx=i;paint();}
        else if(e.key==='Home'){idx=[...sel.options].findIndex(o=>!o.disabled);paint();}
        else if(e.key==='End'){idx=n-1-[...sel.options].reverse().findIndex(o=>!o.disabled);paint();}
        else if(e.key==='Enter'||e.key===' '){choose(idx);}
        else if(e.key==='Escape'){close(true);}
        else if(e.key==='Tab'){close();handled=false;}
        else handled=false;
        if(handled){e.preventDefault();e.stopPropagation();}
        return;
      }
      if(custom(e.target)&&(e.key==='Enter'||e.key===' '||(e.altKey&&e.key==='ArrowDown'))){e.preventDefault();open(e.target);}
    },true);
    window.addEventListener('resize',()=>close());
    window.addEventListener('scroll',e=>{if(list&&!list.contains(e.target))close();},true);
  })();
  // ---- Font choice (fonts are bundled in assets/fonts, no internet needed) ----
  (function fontChoice(){
    const KEY='relationship-map-font',sel=$('#font-select');if(!sel)return;
    let cur='zain';try{const v=localStorage.getItem(KEY);if(v==='plex'||v==='system')cur=v;}catch(_){}
    function apply(v){cur=v;if(v==='zain')document.documentElement.removeAttribute('data-font');else document.documentElement.dataset.font=v;sel.value=v;try{localStorage.setItem(KEY,v);}catch(_){}}
    apply(cur);
    sel.addEventListener('change',()=>apply(sel.value));
  })();
  // ---- Confirmation dialog (replaces the browser's plain confirm box) ----
  function confirmDialog({title,message='',subject=null,listTitle='',items=[],hint='',confirmText='حذف',cancelText='إلغاء',danger=true}){
    return new Promise(resolve=>{
      $('#confirm-modal')?.remove();
      const prev=document.activeElement,m=document.createElement('div');m.id='confirm-modal';m.className='confirm-modal';
      m.innerHTML=`<div class="confirm-backdrop"></div><section class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" aria-describedby="cf-msg"><div class="confirm-icon${danger?' danger':''}" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg></div><h2 id="cf-title">${esc(title)}</h2>${subject?`<div class="confirm-subject"><i style="background:${subject.color}"></i><span><b>${esc(subject.name)}</b><small>${esc(subject.sub)}</small></span></div>`:''}<p id="cf-msg">${esc(message)}</p>${items.length?`<div class="confirm-list-wrap">${listTitle?`<span class="confirm-list-title">${esc(listTitle)}</span>`:''}<ul class="confirm-list">${items.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div>`:''}${hint?`<p class="confirm-hint">${esc(hint)}</p>`:''}<div class="confirm-actions"><button type="button" class="secondary-btn" data-cf="no">${esc(cancelText)}</button><button type="button" class="${danger?'danger-solid':'primary-btn'}" data-cf="yes">${esc(confirmText)}</button></div></section>`;
      document.body.append(m);
      const yes=m.querySelector('[data-cf=yes]'),no=m.querySelector('[data-cf=no]');
      const done=v=>{document.removeEventListener('keydown',onKey,true);m.remove();try{prev?.focus?.({preventScroll:true});}catch(_){/* focus is best-effort */}resolve(v);};
      function onKey(e){
        if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();done(false);return;}
        if(e.key==='Tab'){e.preventDefault();(document.activeElement===yes?no:yes).focus();return;}
        if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();(document.activeElement===yes?no:yes).focus();return;}
        if(e.key==='Delete'||e.key==='Backspace')e.preventDefault();
        e.stopImmediatePropagation();
      }
      document.addEventListener('keydown',onKey,true);
      yes.addEventListener('click',()=>done(true));no.addEventListener('click',()=>done(false));
      m.querySelector('.confirm-backdrop').addEventListener('click',()=>done(false));
      no.focus();
    });
  }
  // ---- Interface preferences ----
  const uiPrefs={hidePanel:true};
  (function wireUiPrefs(){
    const KEY='relationship-map-hide-panel-on-click',sw=$('#hide-panel-switch');
    try{const v=localStorage.getItem(KEY);if(v==='0')uiPrefs.hidePanel=false;}catch(_){/* default stays on */}
    if(!sw)return;sw.checked=uiPrefs.hidePanel;
    sw.addEventListener('change',()=>{uiPrefs.hidePanel=sw.checked;try{localStorage.setItem(KEY,sw.checked?'1':'0');}catch(_){/* not persisted */}});
  })();
  // ---- Overview map header: zoom level, fit, collapse ----
  (function minimapChrome(){
    const wrap=$('#minimap-wrap');if(!wrap)return;const KEY='relationship-map-minimap-collapsed',tg=$('#minimap-toggle');
    function setCollapsed(c){wrap.classList.toggle('collapsed',c);if(tg){tg.setAttribute('aria-expanded',String(!c));tg.title=c?'إظهار النظرة العامة':'طي النظرة العامة';}try{localStorage.setItem(KEY,c?'1':'0');}catch(_){/* not persisted */}}
    let c=false;try{c=localStorage.getItem(KEY)==='1';}catch(_){/* default open */}setCollapsed(c);
    tg?.addEventListener('click',()=>setCollapsed(!wrap.classList.contains('collapsed')));
    $('#minimap-fit')?.addEventListener('click',()=>fitView());
    $('#minimap-zoom')?.addEventListener('click',()=>fitView());
  })();
  function focusFirstSearchResult(){
    const q=state.search.trim().toLocaleLowerCase();if(!q)return;
    const hit=state.nodes.find(n=>[labelOf(n),n.id,n.labelEn,n.summary,n.schema,n.country,n.url,...(Array.isArray(n.subjects)?n.subjects:[])].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)&&(state.schema==='all'||n.schema===state.schema));
    if(hit){selectNode(nodeId(hit.id));centerOn(nodeId(hit.id));}
  }
  // The overview shows the whole graph (plus the part currently on screen), centred and scaled to fill the frame.
  let mmView={x:0,y:0,w:1200,h:760};
  function minimapBounds(v){
    const LW=220,LH=139;let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const n of state.nodes){const id=nodeId(n.id);if(isNodeCollapsed(id))continue;const p=state.positions.get(id);if(!p)continue;if(p.x<x0)x0=p.x;if(p.x>x1)x1=p.x;if(p.y<y0)y0=p.y;if(p.y>y1)y1=p.y;}
    if(!isFinite(x0)){x0=0;y0=0;x1=1200;y1=760;}
    if(v){x0=Math.min(x0,v.x);y0=Math.min(y0,v.y);x1=Math.max(x1,v.x+v.w);y1=Math.max(y1,v.y+v.h);}
    const padX=Math.max(30,(x1-x0)*.06),padY=Math.max(30,(y1-y0)*.06);x0-=padX;x1+=padX;y0-=padY;y1+=padY;
    let w=x1-x0,h=y1-y0;if(w/h<LW/LH)w=h*LW/LH;else h=w*LH/LW;
    mmView={x:(x0+x1)/2-w/2,y:(y0+y1)/2-h/2,w,h};return mmView;
  }
  function drawMinimap(){
    const canvas=$('#minimap');if(!canvas)return;const ctx=canvas.getContext('2d');if(!ctx)return;
    const LW=220,LH=139,k=canvas.width/LW;ctx.setTransform(k,0,0,k,0,0);ctx.clearRect(0,0,LW,LH);
    const bg=ctx.createLinearGradient(0,0,0,LH);bg.addColorStop(0,'#0f141c');bg.addColorStop(1,'#090c11');ctx.fillStyle=bg;ctx.fillRect(0,0,LW,LH);
    ctx.strokeStyle='rgba(255,255,255,.035)';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<=LW;x+=22){ctx.moveTo(x,0);ctx.lineTo(x,LH);}for(let y=0;y<=LH;y+=23){ctx.moveTo(0,y);ctx.lineTo(LW,y);}ctx.stroke();
    const v=visibleGraphRect(),mm=minimapBounds(v),sx=LW/mm.w,sy=sx,ox=mm.x*sx,oy=mm.y*sy,sel=state.selected,near=new Set();
    if(sel!=null)for(const r of (state.adjacency.get(sel)||[]))near.add(r.other);
    ctx.lineWidth=.7;ctx.strokeStyle='rgba(150,162,178,.26)';ctx.beginPath();
    for(const e of state.edges){const a=nodeId(e.source),b=nodeId(e.target);if(isNodeCollapsed(a)||isNodeCollapsed(b))continue;if(sel!=null&&(a===sel||b===sel))continue;const pa=state.positions.get(a),pb=state.positions.get(b);if(!pa||!pb)continue;ctx.moveTo((pa.x*sx-ox),(pa.y*sy-oy));ctx.lineTo((pb.x*sx-ox),(pb.y*sy-oy));}
    ctx.stroke();
    if(sel!=null){ctx.lineWidth=1.2;ctx.strokeStyle='rgba(205,254,100,.75)';ctx.beginPath();for(const r of (state.adjacency.get(sel)||[])){const pa=state.positions.get(sel),pb=state.positions.get(r.other);if(!pa||!pb)continue;ctx.moveTo((pa.x*sx-ox),(pa.y*sy-oy));ctx.lineTo((pb.x*sx-ox),(pb.y*sy-oy));}ctx.stroke();}
    for(const n of state.nodes){const id=nodeId(n.id);if(isNodeCollapsed(id))continue;const p=state.positions.get(id);if(!p)continue;
      const deg=(state.adjacency.get(id)||[]).length,rad=2+Math.min(3,Math.sqrt(deg)*.7),dim=sel!=null&&id!==sel&&!near.has(id);
      ctx.beginPath();ctx.arc((p.x*sx-ox),(p.y*sy-oy),rad,0,Math.PI*2);ctx.globalAlpha=dim?.4:1;ctx.fillStyle=id===sel?'#CDFE64':schemaColor(n.schema);ctx.fill();ctx.globalAlpha=1;
      if(id===sel){ctx.beginPath();ctx.arc((p.x*sx-ox),(p.y*sy-oy),rad+3,0,Math.PI*2);ctx.strokeStyle='rgba(205,254,100,.7)';ctx.lineWidth=1.2;ctx.stroke();}}
    if(v){
      ctx.save();ctx.beginPath();ctx.rect(.75,.75,LW-1.5,LH-1.5);ctx.clip();
      const x=(v.x*sx-ox),y=(v.y*sy-oy),w=v.w*sx,h=v.h*sy;
      ctx.fillStyle='rgba(0,0,0,.38)';ctx.beginPath();ctx.rect(0,0,LW,LH);ctx.rect(x,y,w,h);ctx.fill('evenodd');
      ctx.strokeStyle='#CDFE64';ctx.lineWidth=1.4;ctx.strokeRect(x,y,w,h);
      ctx.restore();
    }
    const z=$('#minimap-zoom');if(z)z.textContent=Math.round(state.scale*100)+'%';
    const c=$('#minimap-count');if(c)c.textContent=`${state.nodes.length} كيان · ${state.edges.length} علاقة`;
  }
  // Part of the graph currently visible in the map frame, in graph coordinates. Uses the SVG's real
  // screen transform, so it stays right when the frame's shape differs from the 1200x760 viewBox.
  function visibleGraphRect(){
    const ctm=svg.getScreenCTM(),r=svg.getBoundingClientRect();if(!ctm||!ctm.a||!r.width)return null;
    const l=(r.left-ctm.e)/ctm.a,t=(r.top-ctm.f)/ctm.d,rr=(r.right-ctm.e)/ctm.a,b=(r.bottom-ctm.f)/ctm.d;
    return{x:(l-state.tx)/state.scale,y:(t-state.ty)/state.scale,w:(rr-l)/state.scale,h:(b-t)/state.scale};
  }
  // Centre the main view on a point of the graph (graph coordinates).
  function centerViewOn(gx,gy){
    const ctm=svg.getScreenCTM(),r=svg.getBoundingClientRect();if(!ctm||!ctm.a)return;
    const cx=((r.left+r.right)/2-ctm.e)/ctm.a,cy=((r.top+r.bottom)/2-ctm.f)/ctm.d;
    state.tx=cx-gx*state.scale;state.ty=cy-gy*state.scale;applyTransform();
  }
  function minimapPoint(e,canvas){const r=canvas.getBoundingClientRect(),m=mmView;return{x:m.x+(e.clientX-r.left)/r.width*m.w,y:m.y+(e.clientY-r.top)/r.height*m.h};}
  // Press and drag on the overview to move the main map live. Pressing inside the yellow box drags it
  // without jumping; pressing elsewhere first centres the view there, then keeps following the pointer.
  (function wireMinimap(){
    const canvas=$('#minimap');let drag=null;
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==undefined&&e.button!==0)return;e.preventDefault();
      const pt=minimapPoint(e,canvas),v=visibleGraphRect();
      const inside=v&&pt.x>=v.x&&pt.x<=v.x+v.w&&pt.y>=v.y&&pt.y<=v.y+v.h;
      drag={id:e.pointerId,dx:inside?pt.x-(v.x+v.w/2):0,dy:inside?pt.y-(v.y+v.h/2):0};
      try{canvas.setPointerCapture(e.pointerId);}catch(_){/* capture is optional */}
      canvas.classList.add('is-dragging');canvas.focus({preventScroll:true});
      centerViewOn(pt.x-drag.dx,pt.y-drag.dy);
    });
    canvas.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const pt=minimapPoint(e,canvas);centerViewOn(pt.x-drag.dx,pt.y-drag.dy);});
    const end=e=>{if(!drag||(e&&e.pointerId!==drag.id))return;try{canvas.releasePointerCapture(drag.id);}catch(_){/* already released */}drag=null;canvas.classList.remove('is-dragging');saveAutoLayoutState();};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',e=>{
      e.preventDefault();const v=visibleGraphRect();if(!v)return;
      const ctm=svg.getScreenCTM(),r=svg.getBoundingClientRect();
      zoom(e.deltaY<0?1.15:1/1.15,((r.left+r.right)/2-ctm.e)/ctm.a,((r.top+r.bottom)/2-ctm.f)/ctm.d);
    },{passive:false});
    canvas.addEventListener('keydown',e=>{
      const v=visibleGraphRect();if(!v)return;const step=.15;
      if(e.key==='Enter'||e.key===' '){e.preventDefault();fitView();return;}
      const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
      if(d){e.preventDefault();centerViewOn(v.x+v.w/2+d[0]*v.w*step,v.y+v.h/2+d[1]*v.h*step);}
      else if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.2);}
      else if(e.key==='-'){e.preventDefault();zoom(.83);}
    });
  })();
  $('#zoom-in').addEventListener('click',()=>zoom(1.2));$('#zoom-out').addEventListener('click',()=>zoom(.83));$('#center-btn').addEventListener('click',fitView);$('#fit-btn').addEventListener('click',fitView);
  (function setupProfileFilters(){
    const P=window.RelationshipProfile, ids={role:'profile-filter-role',marital:'profile-filter-marital',health:'profile-filter-health',family:'profile-filter-family',minAge:'profile-filter-min-age',maxAge:'profile-filter-max-age',sensitiveSearch:'profile-sensitive-search'};
    $('#profile-filter-marital').insertAdjacentHTML('beforeend',P.MARITAL.map(v=>`<option value="${esc(v.id)}">${esc(v.label)}</option>`).join(''));
    $('#profile-filter-health').insertAdjacentHTML('beforeend',P.HEALTH_STATUS.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join(''));
    Object.entries(ids).forEach(([key,id])=>{const input=$('#'+id);input.addEventListener(input.tagName==='SELECT'||input.type==='checkbox'?'change':'input',()=>{state.profileFilters[key]=input.type==='checkbox'?input.checked:input.value.trim();applyFilters();});});
    const sw=$('#profile-role-label');try{state.showRole=localStorage.getItem('relationship-map-show-role')==='1';}catch(_){}sw.checked=state.showRole;sw.addEventListener('change',()=>{state.showRole=sw.checked;try{localStorage.setItem('relationship-map-show-role',sw.checked?'1':'0');}catch(_){}render();});
  })();
  $('#search').addEventListener('input',e=>{state.search=e.target.value;applyFilters();renderSuggest();});$('#search').addEventListener('keydown',e=>{if(searchSuggestKey(e))return;if(e.key==='Enter'){e.preventDefault();focusFirstSearchResult()}});$('#schema-filter').addEventListener('change',e=>{state.schema=e.target.value;applyFilters()});$('#edge-filter').addEventListener('change',e=>{state.edgeType=e.target.value;applyFilters()});
  $('#lock-nodes-btn').addEventListener('click',()=>{state.lockNodes=!state.lockNodes;const b=$('#lock-nodes-btn');b.setAttribute('aria-pressed',String(state.lockNodes));const lbl=b.querySelector('strong');if(lbl)lbl.textContent=state.lockNodes?'فك قفل العقد':'قفل العقد';b.classList.toggle('is-active',state.lockNodes);});
  $('#shortcuts-btn').addEventListener('click',()=>{$('#shortcuts-help').hidden=!$('#shortcuts-help').hidden;});$('#layout-select').addEventListener('change',e=>{state.layout=e.target.value;layout();render();fitView()});$('#reset-btn').addEventListener('click',()=>{state.search='';state.schema='all';state.edgeType='all';Object.assign(state.profileFilters,{role:'',marital:'',health:'',family:'',minAge:'',maxAge:'',sensitiveSearch:false});document.querySelectorAll('[id^=profile-filter-]').forEach(el=>el.value='');$('#profile-sensitive-search').checked=false;state.selected=null;state.selectedEdgeKey=null;hideContextToolbar();$('#panel-title').textContent='تفاصيل الكيان';$('#search').value='';$('#schema-filter').value='all';$('#edge-filter').value='all';$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>';applyFilters();fitView()});$('#clear-selection').addEventListener('click',()=>{state.selected=null;state.selectedEdgeKey=null;hideContextToolbar();$('#panel-title').textContent='تفاصيل الكيان';applyFilters();$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>'});
  function nodeOptions(selected=''){return state.nodes.map(n=>`<option value="${esc(nodeId(n.id))}" ${nodeId(n.id)===String(selected)?'selected':''}>${esc(labelOf(n))} · ${esc(TYPE_AR[n.schema]||n.schema||'كيان')}</option>`).join('');}
  function openToolModal(title,bodyHtml,afterOpen){let modal=$('#phase4-modal');if(!modal){modal=document.createElement('div');modal.id='phase4-modal';modal.className='editor-modal';document.body.append(modal);}modal.innerHTML=`<div class="editor-backdrop" data-phase4-close></div><section class="editor-card phase4-card" role="dialog" aria-modal="true" aria-labelledby="phase4-title"><div class="editor-head"><h2 id="phase4-title">${esc(title)}</h2><button type="button" class="icon-btn" data-phase4-close aria-label="إغلاق">×</button></div>${bodyHtml}<div class="editor-actions"><button type="button" class="secondary-btn" data-phase4-close>إغلاق</button></div></section>`;modal.classList.add('open');modal.querySelectorAll('[data-phase4-close]').forEach(b=>b.addEventListener('click',()=>modal.classList.remove('open')));afterOpen?.(modal);}
  function shortestPath(start,end){start=String(start);end=String(end);if(!state.byId.has(start)||!state.byId.has(end))return null;const prev=new Map(),q=[start],seen=new Set([start]);for(let i=0;i<q.length;i++){const u=q[i];if(u===end)break;for(const rel of state.adjacency.get(u)||[]){if(!seen.has(rel.other)){seen.add(rel.other);prev.set(rel.other,{from:u,edge:rel.edge._key});q.push(rel.other);}}}if(!seen.has(end))return null;const nodes=[end],edges=[];let cur=end;while(cur!==start){const step=prev.get(cur);if(!step)return null;edges.push(step.edge);cur=step.from;nodes.push(cur);}return {nodes:nodes.reverse(),edges:edges.reverse()};}
  function openPathTool(){const selected=state.selected||nodeId(state.nodes[0]?.id||'');openToolModal('إيجاد المسار بين كيانين',`<p class="phase4-intro">يعرض أقصر مسار متاح اعتمادًا على العلاقات الموجودة، دون تعديل البيانات.</p><div class="editor-fields"><label class="editor-field wide"><span>من الكيان</span><select id="path-start">${nodeOptions(selected)}</select></label><label class="editor-field wide"><span>إلى الكيان</span><select id="path-end">${nodeOptions(state.nodes.find(n=>nodeId(n.id)!==selected)?.id||'')}</select></label></div><div id="path-result" class="phase4-result" aria-live="polite"></div><div class="editor-actions"><button type="button" class="primary-btn" id="find-path-btn">إيجاد المسار</button><button type="button" class="secondary-btn" id="clear-path-btn">مسح إبراز المسار</button></div>`,modal=>{modal.querySelector('#find-path-btn').addEventListener('click',()=>{const a=modal.querySelector('#path-start').value,b=modal.querySelector('#path-end').value;if(a===b){modal.querySelector('#path-result').textContent='اختر كيانين مختلفين.';return;}const path=shortestPath(a,b);if(!path){state.pathNodeIds.clear();state.pathEdgeKeys.clear();applyFilters();modal.querySelector('#path-result').textContent='لا يوجد مسار بين هذين الكيانين في الشبكة الحالية.';return;}state.pathNodeIds=new Set(path.nodes);state.pathEdgeKeys=new Set(path.edges);state.selected=null;state.hopLimit=0;$('#hop-level-select').value='0';applyFilters();centerOn(path.nodes[Math.floor(path.nodes.length/2)]);modal.querySelector('#path-result').innerHTML=`<strong>تم العثور على مسار من ${path.nodes.length} كيان و${path.edges.length} علاقة</strong><ol>${path.nodes.map(id=>`<li>${esc(labelOf(state.byId.get(id)))}</li>`).join('')}</ol>`;setStatus(`مسار: ${path.nodes.length} كيان · ${path.edges.length} علاقة`);});modal.querySelector('#clear-path-btn').addEventListener('click',()=>{state.pathNodeIds.clear();state.pathEdgeKeys.clear();applyFilters();modal.querySelector('#path-result').textContent='تم مسح إبراز المسار.';});});}
  function openCompareTool(){const selected=state.selected||nodeId(state.nodes[0]?.id||'');openToolModal('مقارنة كيانين',`<p class="phase4-intro">مقارنة الحقول المتاحة والخصائص والعلاقات المباشرة للكيانين.</p><div class="editor-fields"><label class="editor-field"><span>الكيان الأول</span><select id="compare-a">${nodeOptions(selected)}</select></label><label class="editor-field"><span>الكيان الثاني</span><select id="compare-b">${nodeOptions(state.nodes.find(n=>nodeId(n.id)!==selected)?.id||'')}</select></label></div><div id="compare-result" class="compare-grid"></div><div class="editor-actions"><button type="button" class="primary-btn" id="run-compare-btn">مقارنة</button></div>`,modal=>{modal.querySelector('#run-compare-btn').addEventListener('click',()=>{const a=state.byId.get(modal.querySelector('#compare-a').value),b=state.byId.get(modal.querySelector('#compare-b').value),out=modal.querySelector('#compare-result');if(!a||!b||nodeId(a.id)===nodeId(b.id)){out.textContent='اختر كيانين مختلفين للمقارنة.';return;}const details=n=>{const rels=state.adjacency.get(nodeId(n.id))||[];const attrs=n.attributes&&typeof n.attributes==='object'?n.attributes:{};const rows=[['المعرّف',n.id],['الاسم',labelOf(n)],['النوع',TYPE_AR[n.schema]||n.schema||'كيان'],['الحالة',statusLabel(n.status)||'—'],['الدولة',n.country||'—'],['عدد العلاقات',rels.length],['الموضوعات',Array.isArray(n.subjects)?n.subjects.join('، ')||'—':'—'],...Object.entries(attrs).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])];return `<section class="compare-column"><h3>${esc(labelOf(n))}</h3><dl>${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${window.RelationshipProfileUI?.compare(n)||''}<h4>العلاقات المباشرة</h4><ul>${rels.map(r=>`<li>${esc(edgeType(r.edge))} ← ${esc(labelOf(state.byId.get(r.other)))}</li>`).join('')||'<li>لا توجد علاقات</li>'}</ul><button class="secondary-btn" type="button" data-focus-compare="${esc(nodeId(n.id))}">الانتقال إلى الكيان</button></section>`;};out.innerHTML=details(a)+details(b);out.querySelectorAll('[data-profile-compare]').forEach(el=>window.RelationshipProfileUI?.wirePanel(el,el.dataset.profileCompare));out.querySelectorAll('[data-focus-compare]').forEach(btn=>btn.addEventListener('click',()=>{modal.classList.remove('open');selectNode(btn.dataset.focusCompare);centerOn(btn.dataset.focusCompare);}));});});}
  function toggleCollapseGroup(){const schema=$('#collapse-schema-select').value;if(!schema){setStatus('اختر نوع الكيان أولًا',false);return;}if(state.collapsedGroups.has(schema)){state.collapsedGroups.delete(schema);setStatus(`تم توسيع مجموعة ${TYPE_AR[schema]||schema}`);}else{const members=state.nodes.filter(n=>String(n.schema||'Thing')===schema);if(members.length<2){setStatus('تحتاج المجموعة إلى كيانين على الأقل',false);return;}state.collapsedGroups.add(schema);if(state.selected&&isNodeCollapsed(state.selected))state.selected=getGroupRepresentative(schema);setStatus(`تم طي ${members.length} كيانًا من نوع ${TYPE_AR[schema]||schema} بصريًا`);}$('#collapse-group-btn').textContent=state.collapsedGroups.has(schema)?'توسيع المجموعة':'طي المجموعة';render();applyFilters();if(state.selected)selectNode(state.selected);}
  function downloadBlob(name, content, type){
    const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportGraph(includeSensitive=false,backup=false){
    const nodes=state.data.nodes.map(n=>{const copy=cleanRecord(n);if(copy.profile&&!backup){const p=window.RelationshipProfile.exportProfile(copy.profile,includeSensitive);if(p)copy.profile=p;else delete copy.profile;}return copy;});
    const nodeIds=new Set(nodes.map(n=>nodeId(n.id)));
    const edges=state.data.edges.filter(e=>nodeIds.has(nodeId(e.source))&&nodeIds.has(nodeId(e.target))).map(cleanRecord);
    downloadBlob(backup?'relationship-network-backup.json':'relationship-network.json',JSON.stringify({exportedAt:new Date().toISOString(),nodes,edges,zones:state.data.zones||[]},null,2),'application/json;charset=utf-8');
  }
  function sensitiveExportLines(limit){
    const lines=[];
    for(const n of state.data.nodes){
      const profile=window.RelationshipProfile.normalizeProfile(n.profile);if(!profile)continue;
      const pp=profile.personal||{},secret={};for(const k of ['idNumber','phone','phone2','email'])if(pp[k])secret[k]=pp[k];
      if(profile.health)secret.health=profile.health;
      const family=(profile.family||[]).filter(x=>x.phone).map(x=>({name:x.name||x.relation||'فرد',phone:x.phone}));if(family.length)secret.family=family;
      if(!Object.keys(secret).length)continue;
      const text=`${labelOf(n)} · ${JSON.stringify(secret)}`;for(let i=0;i<text.length;i+=110)lines.push(text.slice(i,i+110));
      if(lines.length>limit)throw new Error('البيانات الحساسة كثيرة جدًا لهذا التصدير؛ استخدم JSON أو CSV.');
    }
    return lines;
  }
  function buildSvgString(includeSensitive=false){
    const clone=svg.cloneNode(true);clone.setAttribute('xmlns',NS);clone.setAttribute('width','1200');clone.setAttribute('height','760');
    if(includeSensitive){
      const lines=sensitiveExportLines(120);
      if(lines.length){
        const height=800+lines.length*18;clone.setAttribute('viewBox',`0 0 1200 ${height}`);clone.setAttribute('height',String(height));
        const back=svgEl('rect',{x:0,y:760,width:1200,height:height-760,fill:'#11151b'});clone.append(back);
        const heading=svgEl('text',{x:1180,y:785,fill:'#fff','text-anchor':'end','font-size':'14'});heading.textContent='بيانات حساسة — احفظ الصورة بأمان';clone.append(heading);
        lines.forEach((line,i)=>{const t=svgEl('text',{x:1180,y:805+i*18,fill:'#fff','text-anchor':'end','font-size':'12','font-family':'Arial,sans-serif'});t.textContent=line;clone.append(t);});
      }
    }
    clone.querySelectorAll('.edge-hit').forEach(el=>el.remove());
    const style=svgEl('style');style.textContent='.node-label{font-family:Arial,sans-serif;fill:#e8ebf1;font-size:12px;text-anchor:middle;stroke:#11151b;stroke-width:3px;paint-order:stroke}.edge-label{fill:#9ba4b2;font-size:10px;text-anchor:middle;stroke:#12161c;stroke-width:4px;paint-order:stroke}.edge{fill:none;stroke:#727d8d;stroke-width:1.15;opacity:.48}.edge.highlight{stroke:#cffe64;opacity:.9;stroke-width:2}.edge.alleged{stroke-dasharray:5 5}.edge.sanction{stroke:#ff6268;stroke-dasharray:4 4}.dimmed{opacity:.2}';
    const bg=svgEl('rect',{x:0,y:0,width:1200,height:760,fill:'#0b0f14'});
    clone.insertBefore(bg,clone.firstChild);clone.insertBefore(style,clone.firstChild);return new XMLSerializer().serializeToString(clone);
  }
  function exportSvg(sensitive=false){try{downloadBlob('relationship-network.svg',buildSvgString(sensitive),'image/svg+xml;charset=utf-8');setStatus('تم تجهيز صورة الخريطة (SVG)');}catch(e){setStatus(e.message,false);}}
  function exportPng(sensitive=false){
    let image;try{image=buildSvgString(sensitive);}catch(e){setStatus(e.message,false);return;}
    const img=new Image();
    img.onload=()=>{const c=document.createElement('canvas');c.width=2400;c.height=Math.ceil(2400*(img.naturalHeight||760)/(img.naturalWidth||1200));const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);c.toBlob(b=>{if(!b){setStatus('تعذر إنشاء الصورة',false);return;}downloadBlob('relationship-network.png',b,'image/png');setStatus('تم تجهيز صورة الخريطة (PNG)');},'image/png');};
    img.onerror=()=>setStatus('تعذر إنشاء الصورة',false);
    img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(image);
  }
  function csvCell(v){let t=v===undefined||v===null?'':String(v);if(/^[\s]*[=+\-@]/.test(t))t="'"+t;return /[",\n\r]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;}
  function toCsv(rows){return '﻿'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';}
  function exportCsv(kind,includeSensitive=false){
    if(kind==='nodes'){
      const fields=[['تاريخ الميلاد',p=>p.personal?.birthDate],['مكان الميلاد',p=>p.personal?.birthPlace],['الجنس',p=>p.personal?.gender],['الجنسية',p=>p.personal?.nationality],['العنوان',p=>p.personal?.address],['المهنة',p=>p.personal?.occupation],['التعليم',p=>p.personal?.education],['ملاحظات شخصية',p=>p.personal?.notes],['الحالة الاجتماعية',p=>p.maritalStatus],['ملاحظات الحالة الاجتماعية',p=>p.maritalNote],['المنصب',p=>p.role?.title],['المجموعة',p=>p.role?.group],['معرّف المجموعة',p=>p.role?.groupId],['تاريخ بدء الدور',p=>p.role?.since],['تاريخ انتهاء الدور',p=>p.role?.until],['ملاحظات الدور',p=>p.role?.notes],['العائلة JSON',p=>p.family?JSON.stringify(p.family):'']];
      if(includeSensitive)fields.push(['رقم الهوية',p=>p.personal?.idNumber],['الهاتف',p=>p.personal?.phone],['هاتف إضافي',p=>p.personal?.phone2],['البريد الإلكتروني',p=>p.personal?.email],['الحالة الصحية',p=>p.health?.status],['الحالات الصحية',p=>p.health?.conditions?.join('، ')],['الأدوية',p=>p.health?.medications],['الحساسية',p=>p.health?.allergies],['فصيلة الدم',p=>p.health?.bloodType],['الإعاقة',p=>p.health?.disability],['آخر فحص',p=>p.health?.lastCheck],['ملاحظات صحية',p=>p.health?.notes]);
      const rows=[['المعرّف','الاسم','النوع','الحالة','الدولة','الشكل القانوني','الوصف','الرابط',...fields.map(x=>x[0])]].concat(state.data.nodes.map(n=>{const p=window.RelationshipProfile.exportProfile(n.profile,includeSensitive)||{};return [n.id,labelOf(n),TYPE_AR[n.schema]||n.schema||'',statusLabel(n.status)||'',countryAr(n.country),n.legalForm||'',n.summary||'',n.url||'',...fields.map(x=>x[1](p)||'')];}));
      downloadBlob('entities.csv',toCsv(rows),'text/csv;charset=utf-8');setStatus(`تم تجهيز جدول الكيانات (${state.data.nodes.length})`);
    }else{
      const name=id=>{const n=state.byId.get(nodeId(id));return n?labelOf(n):String(id);};
      const rows=[['المعرّف','من','إلى','النوع','التسمية','الدور','الثقة %','الحالة']].concat(state.data.edges.map(e=>[e.id,name(e.source),name(e.target),typeAr(e.type),e.label||'',e.role||'',e.confidence??'',statusLabel(e.status)||'']));
      downloadBlob('relationships.csv',toCsv(rows),'text/csv;charset=utf-8');setStatus(`تم تجهيز جدول العلاقات (${state.data.edges.length})`);
    }
  }
  $('#path-tool-btn').addEventListener('click',openPathTool);$('#compare-tool-btn').addEventListener('click',openCompareTool);$('#hop-level-select').addEventListener('change',e=>{state.hopLimit=Number(e.target.value)||0;state.pathNodeIds.clear();state.pathEdgeKeys.clear();applyFilters();if(state.hopLimit&&!state.selected){setStatus('حدد كيانًا أولًا لتطبيق مستوى الجوار',false);}else setStatus(state.hopLimit?`إبراز الجوار حتى ${state.hopLimit} مستوى`:'تم إلغاء تحديد مستوى الجوار');});
  function openProfileExport(kind){
    const title=kind==='json'?'تصدير بيانات JSON':'تصدير جدول الكيانات CSV';
    openToolModal(title,`<p class="phase4-intro">تُستبعد أرقام الهوية والهواتف والبريد وبيانات الصحة افتراضيًا. النسخ الاحتياطية المحلية تحتفظ بكل البيانات.</p><label class="profile-check"><input type="checkbox" id="export-sensitive"> تضمين البيانات الحساسة (الهوية، الهاتف، البريد، الصحة)</label><div class="editor-actions"><button type="button" class="primary-btn" id="profile-export-confirm">تصدير</button></div>`,m=>{m.querySelector('#profile-export-confirm').addEventListener('click',()=>{const sensitive=m.querySelector('#export-sensitive').checked;m.classList.remove('open');if(kind==='json')exportGraph(sensitive);else exportCsv('nodes',sensitive);});});
  }
  $('#backup-json-btn').addEventListener('click',async()=>{const ok=await confirmDialog({title:'تنزيل نسخة احتياطية كاملة؟',message:'ستحتوي النسخة على جميع البيانات الحساسة بما فيها الهوية والهواتف والبريد والصحة. احتفظ بها في مكان آمن.',confirmText:'تنزيل النسخة الكاملة',cancelText:'إلغاء',danger:false});if(ok)exportGraph(true,true);});
  function printGraphPdf(sensitive=false){
    let image,lines;try{image=buildSvgString(false);lines=sensitive?sensitiveExportLines(2000):[];}catch(e){setStatus(e.message,false);return;}
    // Do not request external photos or resources while generating a printable document.
    const parsed=new DOMParser().parseFromString(image,'image/svg+xml');
    parsed.querySelectorAll('image').forEach(el=>{const href=el.getAttribute('href')||el.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';if(!/^(data:|blob:)/i.test(href))el.remove();});
    const safeSvg=new XMLSerializer().serializeToString(parsed.documentElement);
    const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.title='معاينة الطباعة';frame.style.cssText='position:fixed;width:1px;height:1px;left:-100px;top:0;border:0';
    const appendix=lines.length?`<section><h1>بيانات حساسة — احفظ الملف بأمان</h1>${lines.map(line=>`<p dir="ltr">${esc(line)}</p>`).join('')}</section>`:'';
    frame.srcdoc=`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'"><style>@page{size:landscape;margin:8mm}body{margin:0;background:white;color:#111;font-family:Arial,sans-serif}svg{display:block;width:100%;height:auto;max-height:180mm}section{break-before:page}section p{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}</style></head><body>${safeSvg}${appendix}</body></html>`;
    frame.addEventListener('load',()=>{try{const w=frame.contentWindow;w.addEventListener('afterprint',()=>frame.remove(),{once:true});w.focus();w.print();setStatus('اختر «حفظ بصيغة PDF» في نافذة الطباعة.');setTimeout(()=>frame.remove(),60000);}catch(_){frame.remove();setStatus('تعذرت فتح نافذة الطباعة. جرّب تصدير SVG.',false);}},{once:true});document.body.append(frame);
  }
  function openGraphicExport(kind){
    openToolModal(kind==='pdf'?'حفظ PDF':'تصدير صورة الشبكة',`<p class="phase4-intro">${kind==='pdf'?'اختر «حفظ بصيغة PDF» في نافذة الطباعة. قد لا تظهر الصور الخارجية. ':''}لا يتضمن التصدير البيانات الحساسة افتراضيًا. عند اختيار تضمينها تُضاف أسفل الرسم؛ احفظ الملف بأمان.</p><label class="profile-check"><input type="checkbox" id="export-sensitive"> تضمين البيانات الحساسة (الهوية، الهاتف، البريد، الصحة)</label><div class="editor-actions"><button type="button" class="primary-btn" id="profile-export-confirm">تصدير</button></div>`,m=>{m.querySelector('#profile-export-confirm').addEventListener('click',()=>{const sensitive=m.querySelector('#export-sensitive').checked;m.classList.remove('open');if(kind==='svg')exportSvg(sensitive);else if(kind==='png')exportPng(sensitive);else printGraphPdf(sensitive);});});
  }
  $('#export-json-btn').addEventListener('click',()=>openProfileExport('json'));$('#export-svg-btn').addEventListener('click',()=>openGraphicExport('svg'));$('#export-png-btn').addEventListener('click',()=>openGraphicExport('png'));$('#export-pdf-btn').addEventListener('click',()=>openGraphicExport('pdf'));$('#export-nodes-csv-btn').addEventListener('click',()=>openProfileExport('csv'));$('#export-edges-csv-btn').addEventListener('click',()=>exportCsv('edges'));
  const STATUS_AR={active:'نشط',alleged:'مزعوم',inactive:'غير نشط',unknown:'غير معروف'};
  function statusLabel(v){return v?(STATUS_AR[v]||v):'';}
  document.addEventListener('keydown',e=>{
    const active=document.activeElement;
    const tag=active?.tagName?.toLowerCase();
    const typing=!!active?.isConnected&&(['input','textarea','select'].includes(tag)||active.isContentEditable);
    const editorOpen=!!($('#editor-modal')?.classList.contains('open'));
    const inEditor=editorOpen&&!!$('#editor-modal')?.contains(active);
    const key=String(e.key||'').toLowerCase();
    // Dataset history shortcuts work after closing an editor even if focus was left on a removed form field.
    if((e.ctrlKey||e.metaKey)&&!inEditor&&!document.querySelector('.ev-modal.open')&&(key==='z'||key==='y')){
      e.preventDefault();e.stopPropagation();
      if(key==='z'&&e.shiftKey)redo();else if(key==='z')undo();else redo();
      return;
    }
    if(e.key==='Escape'){
      if(state.linking){cancelLink('أُلغي الربط');return;}
      const toolModal=document.querySelector('.editor-modal.open:not(#editor-modal)');
      if(toolModal){toolModal.classList.remove('open');return;}
      if(editorOpen)return;
      if(!$('#shortcuts-help').hidden){$('#shortcuts-help').hidden=true;return;}
      if($('#advanced-tools')?.open){$('#advanced-tools').removeAttribute('open');return;}
      state.selected=null;state.selectedEdgeKey=null;hideContextToolbar();$('#panel-title').textContent='تفاصيل الكيان';applyFilters();$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>';return;
    }
    if(typing||editorOpen||document.querySelector('.ev-modal.open')||e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.target?.closest?.('button,summary,a,[role="button"]')&&key!=='e'&&key!=='r'&&key!=='delete'&&key!=='backspace')return;
    if((key==='delete'||key==='backspace')&&!$('#confirm-modal')){
      if(state.selected!=null&&state.byId.has(state.selected)){e.preventDefault();deleteEntity(state.selected);return;}
      if(state.selectedEdgeKey){e.preventDefault();deleteEdge(state.selectedEdgeKey);return;}
      return;
    }
    if(key==='/'){e.preventDefault();$('#search').focus();$('#search').select();}
    else if(key==='f'){e.preventDefault();fitView();}
    else if(key==='+'||key==='='){e.preventDefault();zoom(1.2);}
    else if(key==='-'){e.preventDefault();zoom(.83);}
    else if(key==='e'&&state.selected){e.preventDefault();editEntity(state.selected);}
    else if(key==='r'&&state.selected){e.preventDefault();addEdge();}
    else if(key==='?'){e.preventDefault();$('#shortcuts-help').hidden=!$('#shortcuts-help').hidden;}
  });

  const schemaOptions=[['Person','شخص'],['Organization','منظمة'],['Address','عنوان / موقع'],['Event','حدث'],['Thing','كيان'],['UserAccount','حساب مستخدم']];
  function cleanRecord(record){const out={};for(const [k,v] of Object.entries(record||{})){if(!k.startsWith('_'))out[k]=v;}return out;}
  function datasetSnapshot(){return JSON.parse(JSON.stringify(toPayload(state.data)));}
  function loadAudit(){try{const v=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');auditLog=Array.isArray(v)?v.slice(0,MAX_AUDIT):[];}catch(_){auditLog=[];}}
  function writeAudit(entry){auditLog.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,at:new Date().toISOString(),...entry});auditLog=auditLog.slice(0,MAX_AUDIT);try{localStorage.setItem(HISTORY_KEY,JSON.stringify(auditLog));}catch(_){/* Dataset save remains independent from audit storage. */}}
  function updateHistoryButtons(){const u=$('#undo-btn'),r=$('#redo-btn');if(u){u.disabled=!undoStack.length;u.title=undoStack.length?`تراجع عن ${undoStack.length} خطوة متاحة`:'لا توجد خطوات للتراجع';}if(r){r.disabled=!redoStack.length;r.title=redoStack.length?`إعادة ${redoStack.length} خطوة متاحة`:'لا توجد خطوات للإعادة';}}
  function validateDataset(data){return window.RelationshipDataValidation.validateDataset(data);}
  function storageLabelText(){
    if(dbMode==='halted')return dbHaltMessage||'توقف الحفظ في قاعدة البيانات — أعد تحميل الصفحة';
    if(dbMode==='db'){
      if(saveQueue&&saveQueue.isDirty())return dbRetrying?'تعذر الاتصال بقاعدة البيانات — النسخة المحلية محفوظة وستُعاد المحاولة':'جارٍ الحفظ في قاعدة البيانات…';
      return 'محفوظ في قاعدة البيانات';
    }
    return hasUnsavedChanges?'تغييرات غير محفوظة — نزّل نسخة JSON الآن':'حفظ محلي في المتصفح فقط (الخادم غير متصل) · نزّل نسخة احتياطية';
  }
  function updateStorageControls(){const b=$('#restore-backup-btn');if(b)b.disabled=!localStorage.getItem(STORAGE_BACKUP_KEY);const label=$('#storage-state');if(label)label.textContent=storageLabelText();}
  // Called by the save queue as the database save progresses.
  function onSaveState(state,detail){
    dbRetrying=state==='error';
    if(state==='saved')setStatus(`${lastSaveMessage||'تم الحفظ'} · قاعدة البيانات ✓`);
    else if(state==='error'&&detail&&detail.code==='unauthorized'){
      setStatus('انتهت الجلسة — سجّل الدخول لمتابعة الحفظ (تعديلاتك محفوظة محليًا)',false);
      if(!reloginOpen){reloginOpen=true;showLogin('انتهت جلستك. سجّل الدخول لمتابعة حفظ التعديلات.').then(name=>{reloginOpen=false;setAuthUser(name);});}
    }
    else if(state==='error'){console.warn('Database save failed; will retry');setStatus('تعذر الاتصال بقاعدة البيانات — النسخة المحلية محفوظة وستُعاد المحاولة',false);}
    else if(state==='conflict'){dbMode='halted';dbHaltMessage='تعارض: تغيّرت البيانات في نافذة أو جهاز آخر — أعد تحميل الصفحة';hasUnsavedChanges=true;setStatus('تغيّرت البيانات في مكان آخر. أعد تحميل الصفحة؛ صدّر JSON أولًا إن أردت الاحتفاظ بتعديلاتك.',false);}
    else if(state==='invalid'){dbMode='halted';dbHaltMessage='رفضت قاعدة البيانات الحفظ: '+((detail&&detail.message)||'بيانات غير صالحة');hasUnsavedChanges=true;setStatus(dbHaltMessage,false);}
    updateStorageControls();
  }
  function persistDataset(message){
    const base=message||(dbMode==='db'?'تم حفظ التعديلات':'تم حفظ التعديلات محليًا');
    const payload=JSON.stringify(toPayload(state.data));
    // Always keep the browser copy (cache + local backup), even when the database is the main store.
    let localOk=true,backupSaved=true;
    try{
      const result=window.RelationshipDataPersistence.saveWithBackup(localStorage,STORAGE_KEY,STORAGE_BACKUP_KEY,payload,lastPersistedSnapshot);
      backupSaved=result.backupSaved;
      if(!backupSaved)console.warn('Could not refresh local backup; primary save will still be attempted.');
      lastPersistedSnapshot=payload;
    }catch(err){localOk=false;console.error('Dataset persistence failed');}
    if(dbMode==='db'&&saveQueue){
      // The database is authoritative; a local-cache failure is only a warning while it can still save.
      lastSaveMessage=base;hasUnsavedChanges=false;
      saveQueue.schedule(payload);
      setStatus(localOk?`${base} · جارٍ الحفظ في قاعدة البيانات…`:`${base} · تعذر الحفظ المحلي، جارٍ الحفظ في قاعدة البيانات…`,localOk);
    }else{
      hasUnsavedChanges=!localOk||dbMode==='halted';
      if(localOk)setStatus(backupSaved?base:`${base} (تعذر تحديث النسخة الاحتياطية)`,backupSaved);
      else setStatus('فشل الحفظ — صدّر JSON قبل إغلاق الصفحة',false);
    }
    updateStorageControls();
  }
  function restoreLocalBackup(){
    let data;try{const raw=localStorage.getItem(STORAGE_BACKUP_KEY);if(!raw)throw new Error('لا توجد نسخة احتياطية محلية.');data=validateDataset(JSON.parse(raw));}
    catch(err){setStatus('تعذر قراءة النسخة الاحتياطية؛ تأكد من وجود نسخة صالحة.',false);return;}
    if(!confirm(`استعادة النسخة الاحتياطية؟ ستستبدل البيانات الحالية بـ ${data.nodes.length} كيان و${data.edges.length} علاقة.`))return;
    refreshImported(data);setStatus('تمت استعادة النسخة الاحتياطية وحفظها');
  }
  window.addEventListener('beforeunload',e=>{if(hasUnsavedChanges||(saveQueue&&saveQueue.isDirty())){e.preventDefault();e.returnValue='';}});
  // Push any pending database save as soon as the tab is hidden (switching apps, closing on mobile).
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&saveQueue)saveQueue.flush();});
  function recordMutation(message){
    const current=datasetSnapshot();
    if(!lastCommittedSnapshot){lastCommittedSnapshot=current;writeAudit({action:'تهيئة',message:'بدء سجل التغييرات',nodes:current.nodes.length,edges:current.edges.length});return;}
    if(JSON.stringify(current)!==JSON.stringify(lastCommittedSnapshot)&&!replayingHistory){undoStack.push(lastCommittedSnapshot);if(undoStack.length>MAX_HISTORY)undoStack.shift();redoStack=[];writeAudit({action:'تعديل',message,nodes:current.nodes.length,edges:current.edges.length});}
    lastCommittedSnapshot=current;updateHistoryButtons();
  }
  function restoreHistorySnapshot(snapshot,action){
    const current=datasetSnapshot();replayingHistory=true;
    state.data={nodes:snapshot.nodes.map(n=>({...n})),edges:snapshot.edges.map(e=>({...e})),zones:(snapshot.zones||[]).map(z=>({...z}))};
    const oldPositions=new Map(state.positions);buildGraph(state.data);for(const [id,pos] of oldPositions)if(state.positions.has(id))state.positions.set(id,{...pos});
    state.selected=null;state.selectedEdgeKey=null;hideContextToolbar();$('#panel-title').textContent='تفاصيل الكيان';$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>';render();applyFilters();fitView();
    persistDataset(action==='undo'?'تم التراجع وحفظ البيانات محليًا':'تمت إعادة التغيير وحفظ البيانات محليًا');
    lastCommittedSnapshot=datasetSnapshot();replayingHistory=false;
    writeAudit({action:action==='undo'?'تراجع':'إعادة',message:action==='undo'?'استعادة الحالة السابقة':'إعادة تطبيق تغيير سابق',nodes:state.data.nodes.length,edges:state.data.edges.length});updateHistoryButtons();
  }
  function undo(){if(!undoStack.length)return;redoStack.push(datasetSnapshot());const previous=undoStack.pop();restoreHistorySnapshot(previous,'undo');}
  function redo(){if(!redoStack.length)return;undoStack.push(datasetSnapshot());const next=redoStack.pop();restoreHistorySnapshot(next,'redo');}
  function showAudit(){
    let modal=$('#audit-modal');if(!modal){modal=document.createElement('div');modal.id='audit-modal';modal.className='editor-modal';modal.innerHTML='<div class="editor-backdrop" data-close-audit></div><section class="editor-card audit-card" role="dialog" aria-modal="true" aria-labelledby="audit-title"><div class="editor-head"><h2 id="audit-title">سجل النشاط والتغييرات</h2><button type="button" class="icon-btn" data-close-audit aria-label="إغلاق">×</button></div><p class="audit-note">سجل محلي على هذا المتصفح، وليس سجلًا مركزيًا على الخادم.</p><div id="audit-list" class="audit-list"></div><div class="editor-actions"><button type="button" class="secondary-btn" id="export-audit-btn">تصدير السجل JSON</button><button type="button" class="secondary-btn" data-close-audit>إغلاق</button></div></section>';document.body.append(modal);modal.querySelectorAll('[data-close-audit]').forEach(b=>b.addEventListener('click',()=>modal.classList.remove('open')));modal.querySelector('#export-audit-btn').addEventListener('click',()=>downloadBlob('relationship-network-audit.json',JSON.stringify(auditLog,null,2),'application/json;charset=utf-8'));}
    $('#audit-list').innerHTML=auditLog.length?auditLog.map(x=>`<article class="audit-entry"><div><strong>${esc(x.action||'نشاط')}</strong><time>${esc(new Date(x.at).toLocaleString())}</time></div><p>${esc(x.message||'')}</p><small>${Number(x.nodes)||0} كيان · ${Number(x.edges)||0} علاقة</small></article>`).join(''):'<p class="audit-empty">لا توجد تغييرات مسجلة بعد.</p>';modal.classList.add('open');
  }

  function nextId(records){return records.reduce((m,r)=>Math.max(m,Number(r.id)||0),0)+1;}
  // ---- Entity images that work offline: a picked file or a downloaded copy is stored inside the data (data URL).
  const PHOTO_MAX=320;
  function downscaleImage(src,max=PHOTO_MAX){
    return new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>{
        try{
          const k=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
          const w=Math.max(1,Math.round(img.naturalWidth*k)),h=Math.max(1,Math.round(img.naturalHeight*k));
          const c=document.createElement('canvas');c.width=w;c.height=h;
          c.getContext('2d').drawImage(img,0,0,w,h);
          let out=c.toDataURL('image/webp',.85);
          if(!out.startsWith('data:image/webp'))out=c.toDataURL('image/png');
          resolve(out);
        }catch(e){reject(e)}
      };
      img.onerror=()=>reject(new Error('تعذر قراءة الصورة'));
      img.src=src;
    });
  }
  function readFileAsDataUrl(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(file)})}
  // Turns a remote http(s) address into a stored copy. Tries the server first (no CORS limits), then the browser.
  async function fetchPhotoCopy(url){
    let raw=null;
    if(dbMode==='db'){try{raw=await api.fetchImage(url)}catch(err){if(err&&err.code==='unauthorized')throw err}}
    if(!raw){
      try{const r=await fetch(url,{mode:'cors',referrerPolicy:'no-referrer'});if(!r.ok)throw new Error('http '+r.status);const b=await r.blob();if(!/^image\//.test(b.type))throw new Error('not image');raw=await readFileAsDataUrl(b);}
      catch(_){throw new Error('تعذر تنزيل الصورة')}
    }
    return downscaleImage(raw);
  }
  let photoCaching=false;
  // Stores a local copy of every entity image that is still only a web link. Quiet: failures (offline) are retried later.
  async function cacheRemotePhotos(){
    if(photoCaching||!navigator.onLine)return;
    photoCaching=true;
    try{
      let changed=0;
      for(const n of state.data.nodes){
        if(!n.photo||!/^https?:\/\//i.test(n.photo))continue;
        const url=n.photo;
        try{const copy=await fetchPhotoCopy(url);if(n.photo!==url)continue;n.photoSource=url;n.photo=copy;changed++;}
        catch(err){if(err&&err.code==='unauthorized')break;}
      }
      if(changed)refreshAfterMutation(`تم حفظ ${changed} صورة داخل البرنامج للعرض دون إنترنت`,state.selected,{keepView:true});
    }finally{photoCaching=false}
  }
  window.addEventListener('online',()=>setTimeout(cacheRemotePhotos,800));
  function wirePhotoField(form){
    const hidden=form.elements.namedItem('photo');if(!hidden||hidden.type!=='hidden')return;
    const url=$('#photo-url'),file=$('#photo-file'),pick=$('#photo-pick'),prev=$('#photo-preview'),note=$('#photo-note'),clear=$('#photo-clear');
    const show=()=>{
      const v=hidden.value;
      prev.hidden=!v;if(!v)return;
      prev.querySelector('img').src=v;
      note.textContent=/^data:/.test(v)?'محفوظة داخل البرنامج (تعمل دون إنترنت)':'رابط — ستُحفظ نسخة داخل البرنامج عند الحفظ';
    };
    url.addEventListener('input',()=>{hidden.value=url.value.trim();show()});
    pick.addEventListener('click',()=>file.click());
    file.addEventListener('change',async()=>{
      const f=file.files[0];if(!f)return;
      if(!/^image\//.test(f.type)){alert('اختر ملف صورة.');return}
      pick.disabled=true;
      try{hidden.value=await downscaleImage(await readFileAsDataUrl(f));url.value='';show();}
      catch(err){alert('تعذر قراءة الصورة: '+err.message)}
      finally{pick.disabled=false;file.value=''}
    });
    clear.addEventListener('click',()=>{hidden.value='';url.value='';show()});
    show();
  }
  function openEditor(title,fields,initial,onSave){
    let modal=$('#editor-modal');
    if(!modal){modal=document.createElement('div');modal.id='editor-modal';modal.className='editor-modal';modal.innerHTML='<div class="editor-backdrop" data-close-editor></div><section class="editor-card" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div class="editor-head"><h2 id="editor-title"></h2><button type="button" class="icon-btn" data-close-editor aria-label="إغلاق">×</button></div><form id="editor-form"><div id="editor-fields" class="editor-fields"></div><div class="editor-actions"><button type="button" class="secondary-btn" data-close-editor>إلغاء</button><button type="submit" class="primary-btn">حفظ</button></div></form></section>';document.body.append(modal);
      modal.querySelectorAll('[data-close-editor]').forEach(b=>b.addEventListener('click',closeEditor));
      modal.addEventListener('click',e=>{if(e.target===modal)closeEditor()});
      document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open'))closeEditor()});
    }
    $('#editor-title').textContent=title;
    $('#editor-fields').innerHTML=fields.map(f=>{
      const value=initial?.[f.name]??f.value??'';
      const common=`name="${esc(f.name)}" id="field-${esc(f.name)}"`;
      if(f.type==='select')return `<label class="editor-field"><span>${esc(f.label)}</span><select ${common} ${f.required?'required':''}>${f.options.map(o=>`<option value="${esc(o[0])}" ${String(value)===String(o[0])?'selected':''}>${esc(o[1])}</option>`).join('')}</select></label>`;
      if(f.type==='textarea')return `<label class="editor-field wide"><span>${esc(f.label)}</span><textarea ${common} rows="3" ${f.required?'required':''}>${esc(value)}</textarea></label>`;
      if(f.type==='photo')return `<div class="editor-field wide photo-field"><span>${esc(f.label)}</span><input type="hidden" ${common} value="${esc(value)}"><div class="photo-row"><input type="text" id="photo-url" dir="ltr" placeholder="${esc(f.placeholder||'')}" value="${/^data:/.test(value)?'':esc(value)}"><button type="button" class="secondary-btn" id="photo-pick">اختيار صورة من الجهاز</button><input type="file" id="photo-file" accept="image/*" hidden></div><div class="photo-preview" id="photo-preview" hidden><img alt=""><span id="photo-note"></span><button type="button" class="chip-btn" id="photo-clear">إزالة الصورة</button></div></div>`;
      if(f.type==='checkbox')return `<label class="editor-check"><input type="checkbox" ${common} ${value?'checked':''}><span>${esc(f.label)}</span></label>`;
      return `<label class="editor-field ${f.wide?'wide':''}"><span>${esc(f.label)}</span><input ${common} type="${f.type||'text'}" value="${esc(value)}" ${f.required?'required':''} ${f.placeholder?`placeholder="${esc(f.placeholder)}"`:''}></label>`;
    }).join('');
    const form=$('#editor-form');
    wirePhotoField(form);
    form.onsubmit=e=>{e.preventDefault();const result={};for(const f of fields){const el=form.elements.namedItem(f.name);result[f.name]=f.type==='checkbox'?el.checked:el.value;}const ok=onSave(result);if(ok===false)return;closeEditor();};
    modal.classList.add('open');setTimeout(()=>modal.querySelector('input,select,textarea')?.focus(),30);
  }
  function closeEditor(){const m=$('#editor-modal');if(m)m.classList.remove('open');}
  function entityFields(){
    return [
      {name:'label',label:'اسم الكيان',required:true,wide:true},
      {name:'labelEn',label:'الاسم بالإنجليزية'},
      {name:'schema',label:'نوع الكيان',type:'select',required:true,options:schemaOptions},
      {name:'status',label:'الحالة',type:'select',options:[['active','نشط'],['alleged','مزعوم'],['inactive','غير نشط'],['unknown','غير معروف']]},
      {name:'summary',label:'الوصف / الملخص',type:'textarea'},
      {name:'photo',label:'الصورة (رابط أو ملف من الجهاز)',type:'photo',placeholder:'https://…'},
      {name:'country',label:'الدولة / النطاق'},
      {name:'location',label:'الموقع الحالي',wide:true,placeholder:'مثال: مدينة غزة — حي الرمال'},
      {name:'date',label:'التاريخ (للأحداث)',type:'date'},
      {name:'url',label:'رابط المصدر',wide:true,placeholder:'https://…'},
      {name:'legalForm',label:'الشكل القانوني'},
      {name:'boundary',label:'كيان حدودي',type:'checkbox'},
      {name:'attributesJson',label:'خصائص إضافية (JSON)',type:'textarea',wide:true}
    ];
  }
  function addEntity(){openEditor('إضافة كيان',entityFields(),{schema:'Person',status:'active',boundary:false,attributesJson:'{}'},v=>{
    let attributes;try{attributes=JSON.parse(v.attributesJson||'{}');if(!attributes||Array.isArray(attributes)||typeof attributes!=='object')throw new Error('يجب أن تكون الخصائص كائن JSON.');}catch(err){alert('صيغة الخصائص الإضافية غير صحيحة: '+err.message);return false;}
    const n={id:nextId(state.data.nodes),label:v.label.trim(),labelEn:v.labelEn.trim(),schema:v.schema,status:v.status,summary:v.summary.trim(),photo:v.photo.trim(),country:v.country.trim(),url:v.url.trim(),legalForm:v.legalForm.trim(),boundary:!!v.boundary,subjects:[],attributes};if(v.location.trim())n.location=v.location.trim();if(v.date)n.date=v.date;
    state.data.nodes.push(n);refreshAfterMutation(`تمت إضافة الكيان «${n.label}»`);cacheRemotePhotos();
  });}
  function duplicateEntity(id){const source=state.data.nodes.find(n=>nodeId(n.id)===id);if(!source)return;const copy=JSON.parse(JSON.stringify(source));copy.id=nextId(state.data.nodes);copy.label=`${labelOf(source)} (نسخة)`;delete copy._el;state.data.nodes.push(copy);refreshAfterMutation(`تم نسخ الكيان «${labelOf(source)}»`,nodeId(copy.id));}
  function editEntity(id){const n=state.data.nodes.find(x=>nodeId(x.id)===id);if(!n)return;if(n.schema==='Event'&&window.RelationshipEvents){window.RelationshipEvents.edit(id);return;}const initial={...n,attributesJson:JSON.stringify(n.attributes&&typeof n.attributes==='object'?n.attributes:{},null,2)};openEditor('تعديل الكيان',entityFields(),initial,v=>{
    let attributes;try{attributes=JSON.parse(v.attributesJson||'{}');if(!attributes||Array.isArray(attributes)||typeof attributes!=='object')throw new Error('يجب أن تكون الخصائص كائن JSON.');}catch(err){alert('صيغة الخصائص الإضافية غير صحيحة: '+err.message);return false;}
    Object.assign(n,{label:v.label.trim(),labelEn:v.labelEn.trim(),schema:v.schema,status:v.status,summary:v.summary.trim(),photo:v.photo.trim(),country:v.country.trim(),url:v.url.trim(),legalForm:v.legalForm.trim(),boundary:!!v.boundary,attributes,location:v.location.trim(),date:v.date});if(!n.location)delete n.location;if(!n.date)delete n.date;
    if(!/^https?:/i.test(n.photo||''))delete n.photoSource;refreshAfterMutation(`تم تحديث «${n.label}»`,id);cacheRemotePhotos();
  });}
  async function deleteEntity(id){
    const n=state.data.nodes.find(x=>nodeId(x.id)===id);if(!n)return;
    if(n.schema==='Event'&&window.RelationshipEvents){window.RelationshipEvents.remove(id);return;}
    const rel=state.data.edges.filter(e=>nodeId(e.source)===id||nodeId(e.target)===id);
    const names=rel.map(e=>{const o=nodeId(e.source)===id?nodeId(e.target):nodeId(e.source);const t=state.byId.get(o);return t?labelOf(t):String(o);});
    const ok=await confirmDialog({title:'حذف الكيان؟',subject:{name:labelOf(n),sub:TYPE_AR[n.schema]||n.schema||'كيان',color:schemaColor(n.schema)},
      message:rel.length?`سيُحذف هذا الكيان مع ${rel.length===1?'علاقة واحدة':rel.length===2?'علاقتين':rel.length+(rel.length<=10?' علاقات':' علاقة')} متصلة به.`:'سيُحذف هذا الكيان من الخريطة. لا توجد علاقات متصلة به.',
      listTitle:rel.length?'العلاقات التي ستُحذف معه':'',items:names.slice(0,6).concat(names.length>6?[`+${names.length-6} أخرى`]:[]),
      hint:'يمكنك التراجع بعد الحذف بالضغط على Ctrl+Z.'});
    if(!ok)return;
    state.data.nodes=state.data.nodes.filter(x=>nodeId(x.id)!==id);state.data.edges=state.data.edges.filter(e=>nodeId(e.source)!==id&&nodeId(e.target)!==id);if(state.selected===id)state.selected=null;if(state.hovered===id)state.hovered=null;refreshAfterMutation('تم حذف الكيان والعلاقات المتصلة به');
  }
  function edgeFields(){
    const options=state.nodes.map(n=>[nodeId(n.id),labelOf(n)]);
    const types=[['Associate','ارتباط'],['Membership','عضوية'],['Family','عائلة'],['Located_At','موقع مرتبط'],['Participated_In','مشاركة في حدث'],['Impersonates','انتحال'],['Sanctioned','عقوبات'],['Other','أخرى']];
    return [
      {name:'source',label:'الكيان الأول',type:'select',required:true,options},
      {name:'target',label:'الكيان الثاني',type:'select',required:true,options},
      {name:'type',label:'نوع العلاقة',type:'select',required:true,options:types},
      {name:'label',label:'اسم العلاقة',required:true},
      {name:'role',label:'الدور / التفاصيل',wide:true},
      {name:'confidence',label:'درجة الثقة (0–100)',type:'number'},
      {name:'status',label:'الحالة',type:'select',options:[['active','نشط'],['alleged','مزعوم'],['inactive','غير نشط'],['unknown','غير معروف']]},
      {name:'date',label:'التاريخ',type:'date'}
    ];
  }
  function addEdge(){if(state.nodes.length<2){alert('أضف كيانين على الأقل قبل إنشاء علاقة.');return;}openEditor('إضافة علاقة',edgeFields(),{source:nodeId(state.selected||state.nodes[0].id),target:nodeId(state.nodes.find(n=>nodeId(n.id)!==state.selected)?.id??state.nodes[1].id),type:'Associate',label:'ارتباط',confidence:70,status:'active'},v=>{
    if(v.source===v.target){alert('اختر كيانين مختلفين للعلاقة.');return false;}
    const e={id:nextId(state.data.edges),source:coerceId(v.source),target:coerceId(v.target),type:v.type,label:v.label.trim()||v.type,role:v.role.trim(),confidence:Math.max(0,Math.min(100,Number(v.confidence)||0)),status:v.status};if(v.date)e.date=v.date;
    state.data.edges.push(e);refreshAfterMutation('تمت إضافة العلاقة',v.source);
  });}
  function editEdge(id){const e=state.data.edges.find(x=>nodeId(x.id)===id);if(!e)return;openEditor('تعديل العلاقة',edgeFields(),e,v=>{
    if(v.source===v.target){alert('اختر كيانين مختلفين للعلاقة.');return false;}
    Object.assign(e,{source:coerceId(v.source),target:coerceId(v.target),type:v.type,label:v.label.trim()||v.type,role:v.role.trim(),confidence:Math.max(0,Math.min(100,Number(v.confidence)||0)),status:v.status,date:v.date});if(!e.date)delete e.date;
    refreshAfterMutation('تم تحديث العلاقة',nodeId(e.source));
  });}
  function coerceId(value){const existing=state.data.nodes.find(n=>nodeId(n.id)===String(value));return existing?existing.id:value;}
  async function deleteEdge(id){
    const e=state.data.edges.find(x=>nodeId(x.id)===id);if(!e)return;
    const a=state.byId.get(nodeId(e.source)),b=state.byId.get(nodeId(e.target));
    const ok=await confirmDialog({title:'حذف العلاقة؟',subject:{name:e.label||typeAr(e.type)||'علاقة',sub:`${a?labelOf(a):'—'}  ←  ${b?labelOf(b):'—'}`,color:'var(--lime)'},
      message:'ستُحذف هذه العلاقة فقط، وتبقى الكيانات المرتبطة بها كما هي.',hint:'يمكنك التراجع بعد الحذف بالضغط على Ctrl+Z.'});
    if(!ok)return;
    state.data.edges=state.data.edges.filter(x=>nodeId(x.id)!==id);refreshAfterMutation('تم حذف العلاقة',state.selected);
  }
  function refreshAfterMutation(message,focusId=null,opts={}){
    recordMutation(message);
    state.selectedEdgeKey=null;
    const clean=toPayload(state.data);
    const oldPositions=new Map(state.positions);
    const keptView=opts.keepView?{scale:state.scale,tx:state.tx,ty:state.ty}:null;
    buildGraph(clean);
    for(const [id,p] of oldPositions)if(state.positions.has(id))state.positions.set(id,{...p});
    if(focusId&&state.byId.has(nodeId(focusId))){state.selected=nodeId(focusId);showDetails(state.selected);}
    else if(!state.byId.has(state.selected)){state.selected=null;$('#panel-title').textContent='تفاصيل الكيان';$('#detail-content').innerHTML='<div class="welcome-icon">◉</div><h3>اختر عقدة من الخريطة</h3><p>ستظهر هنا معلومات الكيان والعلاقات المتصلة به.</p>';}
    render();if(keptView){Object.assign(state,keptView);applyTransform();}else fitView();persistDataset(message);
  }
  function importDataset(file){
    const reader=new FileReader();
    reader.onerror=()=>openToolModal('تعذر استيراد الملف',`<p class="phase4-intro import-error">تعذر قراءة الملف المحدد.</p>`);
    reader.onload=()=>{
      let d;try{d=validateDataset(JSON.parse(String(reader.result)));}
      catch(err){openToolModal('تعذر استيراد الملف',`<p class="phase4-intro import-error">${esc(err instanceof SyntaxError?'الملف ليس بصيغة JSON صالحة.':err.message)}</p><p class="phase4-intro">لم يتم تغيير أي بيانات.</p>`);return;}
      const curN=new Set(state.data.nodes.map(n=>nodeId(n.id))),curE=new Set(state.data.edges.map(e=>nodeId(e.id))),curZ=new Set((state.data.zones||[]).map(z=>nodeId(z.id)));
      const newN=d.nodes.filter(n=>!curN.has(nodeId(n.id))).length,newE=d.edges.filter(e=>!curE.has(nodeId(e.id))).length;
      const stat=(v,l)=>`<div class="stat"><strong>${v}</strong><span>${l}</span></div>`;
      openToolModal('استيراد بيانات',`<p class="phase4-intro">الملف: <b dir="ltr">${esc(file.name)}</b></p><div class="stat-grid stat-grid-3">${stat(d.nodes.length,'كيان في الملف')}${stat(d.edges.length,'علاقة في الملف')}${stat(newN+' / '+newE,'جديد (كيانات / علاقات)')}</div>
        <fieldset class="import-modes"><legend>طريقة الاستيراد</legend>
        <label class="import-mode"><input type="radio" name="import-mode" value="merge" checked><span><strong>دمج مع البيانات الحالية</strong><small>يضيف العناصر الجديدة فقط ويُبقي الموجود كما هو (حسب المعرّف)</small></span></label>
        <label class="import-mode"><input type="radio" name="import-mode" value="replace"><span><strong>استبدال البيانات الحالية</strong><small>يحذف ${state.data.nodes.length} كيان و${state.data.edges.length} علاقة حاليًا، مع حفظ نسخة سابقة يمكن استعادتها</small></span></label></fieldset>
        <div class="editor-actions"><button type="button" class="primary-btn" id="import-confirm-btn">استيراد</button></div>`,modal=>{
        modal.querySelector('#import-confirm-btn').addEventListener('click',()=>{
          const mode=modal.querySelector('input[name=import-mode]:checked').value;let result=d;
          if(mode==='merge'){
            try{result=validateDataset({nodes:state.data.nodes.concat(d.nodes.filter(n=>!curN.has(nodeId(n.id)))),edges:state.data.edges.concat(d.edges.filter(e=>!curE.has(nodeId(e.id)))),zones:(state.data.zones||[]).concat((d.zones||[]).filter(z=>!curZ.has(nodeId(z.id))))});}
            catch(err){modal.querySelector('.import-modes').insertAdjacentHTML('afterend',`<p class="phase4-intro import-error">${esc(err.message)}</p>`);return;}
          }
          modal.classList.remove('open');state.selected=null;state.hovered=null;refreshImported(result);
          setStatus(mode==='merge'?`تم دمج ${newN} كيان و${newE} علاقة جديدة`:'تم استبدال البيانات بالملف المستورد');
        });
      });
    };
    reader.readAsText(file);
  }
  function refreshImported(data){state.data={nodes:data.nodes,edges:data.edges,zones:data.zones||[]};recordMutation('استيراد مجموعة بيانات');buildGraph(state.data);persistDataset('تم استيراد البيانات وحفظها محليًا');}
  $('#account-btn')?.addEventListener('click',openAccount);
  $('#add-node-btn').addEventListener('click',addEntity);
  $('#add-edge-btn').addEventListener('click',addEdge);
  $('#import-json-btn').addEventListener('click',()=>$('#import-json-input').click());
  $('#import-json-input').addEventListener('change',e=>{if(e.target.files?.[0])importDataset(e.target.files[0]);e.target.value='';});
  $('.advanced-tools-menu').addEventListener('click',e=>{if(e.target.closest('button'))$('#advanced-tools')?.removeAttribute('open');});
  // The tools menu closes on any click or tap outside it (toolbar, header, side panel, map...) and on Esc.
  document.addEventListener('pointerdown',e=>{const d=$('#advanced-tools');if(d?.open&&!d.contains(e.target)&&!e.target.closest('.dd-list'))d.removeAttribute('open');},true);
  document.addEventListener('keydown',e=>{const d=$('#advanced-tools');if(e.key==='Escape'&&d?.open){d.removeAttribute('open');$('#advanced-tools summary')?.focus();}});
  
  $('#undo-btn').addEventListener('click',undo);$('#redo-btn').addEventListener('click',redo);$('#audit-btn').addEventListener('click',showAudit);$('#restore-backup-btn').addEventListener('click',restoreLocalBackup);
  // Browser-only data source (used when there is no database API, and to seed an empty database):
  // the saved local dataset, its backup if it is corrupt, or finally data/network.json.
  async function loadLocalOrBase(){
    const fetchBase=async primaryError=>{const response=await fetch('data/network.json');if(!response.ok)throw primaryError||new Error('تعذر تحميل data/network.json');return validateDataset(await response.json());};
    const saved=localStorage.getItem(STORAGE_KEY);
    if(!saved)return{parsed:await fetchBase(),loadedFrom:'initial'};
    try{return{parsed:validateDataset(JSON.parse(saved)),loadedFrom:'local'};}
    catch(primaryError){
      console.error('Saved dataset is invalid; preserving it and attempting recovery');
      try{localStorage.setItem('relationship-network-corrupt-recovery-v1',saved);}catch(recoveryError){console.error('Could not preserve corrupted local data');}
      const backup=localStorage.getItem(STORAGE_BACKUP_KEY);
      if(backup){
        try{const parsed=validateDataset(JSON.parse(backup));localStorage.removeItem(STORAGE_KEY);localStorage.setItem(STORAGE_KEY,JSON.stringify(toPayload(parsed)));return{parsed,loadedFrom:'backup'};}
        catch(backupError){console.error('Local backup is invalid too');}
      }
      localStorage.removeItem(STORAGE_KEY);
      return{parsed:await fetchBase(primaryError),loadedFrom:'recovered-base'};
    }
  }
  async function init(){try{
    await ensureLoggedIn();
    loadAudit();
    let remote=null,seedFailed=false;
    try{remote=await api.loadGraph();}catch(err){console.warn('Database API unavailable; using browser storage only.');}
    let parsed,loadedFrom;
    if(remote){
      dbMode='db';dbRevision=remote.revision;
      if(!remote.nodes.length&&!remote.edges.length&&remote.revision===0){
        // First run against an empty database: move the browser's saved data (or the starter data) into it.
        const local=await loadLocalOrBase();parsed=local.parsed;loadedFrom=local.loadedFrom;
        try{const seeded=await api.saveGraph(toPayload(parsed),0,`seed-${Date.now().toString(36)}`);dbRevision=seeded.revision;loadedFrom=(loadedFrom==='local'||loadedFrom==='backup')?'seeded-local':'seeded-base';}
        catch(seedError){console.error('Could not seed the database; continuing with browser storage');dbMode='local';seedFailed=true;}
      }else{parsed=validateDataset(remote);loadedFrom='database';}
    }else{const local=await loadLocalOrBase();parsed=local.parsed;loadedFrom=local.loadedFrom;}
    buildGraph(parsed);lastPersistedSnapshot=JSON.stringify(toPayload(parsed));
    if(dbMode==='db'){
      try{localStorage.setItem(STORAGE_KEY,lastPersistedSnapshot);}catch(cacheError){console.warn('Could not refresh the local cache');}
      saveQueue=window.RelationshipApi.createSaveQueue(async(payload,requestId,ackId)=>{const saved=await api.saveGraph(JSON.parse(payload),dbRevision,requestId,ackId);dbRevision=saved.revision;},onSaveState);
    }
    lastCommittedSnapshot=datasetSnapshot();
    let dbLayout=null;
    if(dbMode==='db'){
      layoutQueue=window.RelationshipApi.createSaveQueue(async payload=>{await api.saveLayout(JSON.parse(payload));},(st,err)=>{if(st==='error'){console.warn('Saving the map arrangement to the database failed; will retry',err);if(err&&err.code==='unauthorized'&&!reloginOpen){reloginOpen=true;showLogin('انتهت جلستك. سجّل الدخول لمتابعة الحفظ.').then(name=>{reloginOpen=false;setAuthUser(name);});}}},{delay:900});
      try{dbLayout=await api.loadLayout();}catch(layoutError){console.warn('Could not load the saved map arrangement from the database',layoutError);}
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&layoutQueue&&layoutQueue.isDirty())layoutQueue.flush();});
    }
    const layoutRestored=restoreAutoLayoutState(dbLayout);
    // First time the database has no arrangement: adopt the one this browser already had.
    if(dbMode==='db'&&!dbLayout&&layoutRestored)scheduleDbLayoutSave();
    updateHistoryButtons();updateStorageControls();
    const counts=`${state.nodes.length} كيان · ${state.edges.length} علاقة`;
    if(loadedFrom==='database')setStatus(`${counts} · من قاعدة البيانات`);
    else if(loadedFrom==='seeded-local')setStatus(`${counts} · نُقلت بياناتك المحفوظة في المتصفح إلى قاعدة البيانات`);
    else if(loadedFrom==='seeded-base')setStatus(`${counts} · قاعدة البيانات كانت فارغة؛ حُمّلت البيانات الأساسية وحُفظت`);
    else if(seedFailed)setStatus(`${counts} · تعذر الحفظ في قاعدة البيانات؛ الحفظ محلي في المتصفح فقط`,false);
    else if(loadedFrom==='local')setStatus(`${counts} · محفوظ محليًا (الخادم غير متصل)`);
    else if(loadedFrom==='initial')setStatus(`${counts} · البيانات الأساسية (الخادم غير متصل)`);
    else if(loadedFrom==='backup')setStatus('استُعيدت النسخة الاحتياطية بعد خطأ في البيانات المحلية',false);
    else if(loadedFrom==='recovered-base')setStatus('تعذر استرداد البيانات المحلية؛ حُفظت نسختها التالفة وحُمّلت البيانات الأساسية',false);
    setTimeout(cacheRemotePhotos,1500);
  }catch(err){setStatus('تعذر تحميل البيانات',false);$('#detail-content').innerHTML=`<h3>تعذر تحميل البيانات</h3><p>تحقق من اتصال الخادم وسلامة البيانات والنسخ الاحتياطية.<br>شغّل المشروع عبر الخادم: <code>npm start</code> ثم افتح http://127.0.0.1:3000</p>`;console.error('Failed to load dataset')}}
  window.RelationshipHost={state,$,esc,nodeId,labelOf,schemaColor,TYPE_AR,refreshAfterMutation,confirmDialog,selectNode,centerOn,nextId,setStatus,downscaleImage,readFileAsDataUrl,fetchPhotoCopy};
  init();
})();
