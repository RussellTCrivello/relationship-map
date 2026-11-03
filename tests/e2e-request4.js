'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {chromium}=require('playwright');
async function run(){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rm-profile-'));
 Object.assign(process.env,{DB_ENGINE:'file',DATA_FILE:path.join(tmp,'db.json'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password-123'});
 await require('../server/auth.js').getAdmin();const {app}=require('../server/app.js');
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900},locale:'ar'}),errors=[];
  page.on('request',request=>{const u=request.url();if(!/^http:\/\/127\.0\.0\.1/.test(u)&&['ID-123456789','PHONE-987654321','secret@example.test','FAMILY-12345678'].some(x=>decodeURIComponent(u).includes(x)))errors.push('Sensitive value sent externally');});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route(url=>!/^http:\/\/127\.0\.0\.1/.test(url.href)&&!/^(data|blob):/.test(url.href),r=>r.abort());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.ok((await page.request.post(base+'/api/auth/login',{data:{username:'admin',password:'test-password-123'}})).ok());
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.RelationshipHost?.state?.nodes?.length);
  const [id,other,label]=await page.evaluate(()=>{const h=window.RelationshipHost;const a=h.state.nodes.find(x=>x.schema==='Person')||h.state.nodes[0],b=h.state.nodes.find(x=>x.id!==a.id&&x.schema!=='UserAccount');h.selectNode(String(a.id));return [String(a.id),String(b.id),h.labelOf(b)];});
  const overviewBefore=await page.locator('[data-panel="overview"]').innerText();
  await page.click('[data-tab="profile-personal"]');await page.click('[data-profile-edit="personal"]');
  await page.locator('#profile-edit header [data-profile-close]').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('type')),'submit');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-profile-close')),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#profile-edit').evaluate(el=>el.classList.contains('open')),false);assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-profile-edit')),true);await page.click('[data-profile-edit="personal"]');await page.click('#profile-form button[type="submit"]');
  assert.equal(await page.evaluate(id=>Object.hasOwn(window.RelationshipHost.state.byId.get(id),'profile'),id),false,'empty profile must not be stored');
  await page.click('[data-tab="overview"]');assert.equal(await page.locator('[data-panel="overview"]').innerText(),overviewBefore);await page.click('[data-tab="profile-personal"]');
  await page.click('[data-profile-edit="personal"]');await page.fill('[name="personal.birthDate"]','2000-02');await page.fill('[name="personal.gender"]','أنثى');
  await page.fill('[name="personal.idNumber"]','ID-123456789');await page.fill('[name="personal.phone"]','PHONE-987654321');await page.fill('[name="personal.email"]','secret@example.test');
  await page.selectOption('[name="maritalStatus"]','married');await page.fill('[name="role.title"]','منسق اختبار');await page.fill('[name="role.group"]','مجموعة الاختبار');await page.click('#profile-form button[type="submit"]');
  await page.waitForFunction(id=>window.RelationshipHost.state.byId.get(id)?.profile?.role?.title==='منسق اختبار',id);
  assert.equal(await page.locator('[data-profile-value="personal.idNumber"]').innerText(),'••••6789');
  assert.equal((await page.locator('[data-panel="profile-personal"]').innerText()).includes('ID-123456789'),false);
  await page.click('[data-profile-reveal="personal.idNumber"]');assert.equal(await page.locator('[data-profile-value="personal.idNumber"]').innerText(),'ID-123456789');await page.click('[data-profile-reveal="personal.idNumber"]');
  // Background graph refresh must not discard an open editor draft.
  await page.click('[data-profile-edit="personal"]');await page.fill('[name="personal.occupation"]','مهنة اختبار');
  await page.evaluate(id=>window.RelationshipHost.refreshAfterMutation('تحديث في الخلفية',id,{keepView:true}),id);await page.click('#profile-form button[type="submit"]');
  assert.equal(await page.evaluate(id=>window.RelationshipHost.state.byId.get(id).profile.personal.occupation,id),'مهنة اختبار');
  // A truly changed profile must not be silently overwritten by a stale editor.
  await page.click('[data-profile-edit="personal"]');await page.fill('[name="personal.occupation"]','مسودة قديمة');
  await page.evaluate(id=>{const h=window.RelationshipHost;h.state.byId.get(id).profile.personal.occupation='تغيير أحدث';h.refreshAfterMutation('تغيير أحدث',id,{keepView:true});},id);
  await page.click('#profile-form button[type="submit"]');assert.match(await page.locator('#profile-errors').innerText(),/تغيّرت بيانات/);await page.click('#profile-edit header [data-profile-close]');
  await page.click('[data-tab="profile-health"]');await page.click('[data-profile-edit="health"]');await page.selectOption('[name="health.status"]','مستقرة');await page.fill('[name="health.conditions"]','حالة سرية، حالة أخرى');await page.fill('[name="health.notes"]','ملاحظة صحية سرية');await page.click('#profile-form button[type="submit"]');
  assert.equal((await page.locator('[data-panel="profile-health"]').innerText()).includes('ملاحظة صحية سرية'),false);
  await page.click('[data-tab="profile-family"]');await page.click('[data-profile-edit="family"]');await page.click('#profile-family-add');
  await page.selectOption('.profile-family-edit [name="relation"]','أب');await page.fill('.profile-family-edit [name="entitySearch"]',`${label} — ${other}`);await page.fill('.profile-family-edit [name="phone"]','FAMILY-12345678');await page.click('#profile-form button[type="submit"]');
  await page.waitForSelector('#confirm-modal');await page.click('#confirm-modal [data-cf="yes"]');
  await page.waitForFunction(id=>window.RelationshipHost.state.byId.get(id)?.profile?.family?.length,id);
  assert.equal(await page.evaluate(([a,b])=>window.RelationshipHost.state.data.edges.filter(e=>e.type==='Family'&&[String(e.source),String(e.target)].includes(a)&&[String(e.source),String(e.target)].includes(b)).length,[id,other]),1);
  assert.equal(await page.evaluate(([a,b])=>window.RelationshipHost.state.byId.get(b)?.profile?.family?.some(f=>String(f.entityId)===a),[id,other]),true);
  assert.equal((await page.locator('[data-panel="profile-family"]').innerText()).includes('FAMILY-12345678'),false);
  await page.click('#advanced-tools summary');await page.fill('#profile-filter-role','منسق اختبار');await page.selectOption('#profile-filter-marital','married');await page.selectOption('#profile-filter-health','مستقرة');
  assert.equal(await page.evaluate(id=>window.RelationshipHost.state.matchIds.has(id),id),true);
  assert.equal(await page.evaluate(id=>window.RelationshipHost.state.matchIds.has(id),other),false);
  await page.click('#advanced-tools summary');
  await page.evaluate(id=>{const h=window.RelationshipHost;h.state.byId.get(id).geo={lat:31.5,lng:34.4};h.refreshAfterMutation('موقع اختبار',id,{keepView:true});window.RelationshipMap._setView('map');},id);
  await page.waitForFunction(()=>document.querySelector('#geo-count').textContent.includes('1 من 1'));
  await page.evaluate(()=>window.RelationshipMap._setView('graph'));await page.click('#advanced-tools summary');
  await page.click('#export-json-btn');await page.waitForSelector('#phase4-modal.open');
  let dl=page.waitForEvent('download');await page.click('#profile-export-confirm');let file=await dl;let text=fs.readFileSync(await file.path(),'utf8');
  for(const s of ['ID-123456789','PHONE-987654321','secret@example.test','ملاحظة صحية سرية','FAMILY-12345678'])assert.equal(text.includes(s),false,`unsafe export ${s}`);
  await page.click('#advanced-tools summary');await page.click('#export-json-btn');await page.check('#export-sensitive');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;text=fs.readFileSync(await file.path(),'utf8');
  for(const s of ['ID-123456789','PHONE-987654321','secret@example.test','ملاحظة صحية سرية','FAMILY-12345678'])assert.equal(text.includes(s),true,`missing permitted value ${s}`);
  await page.evaluate(id=>{const h=window.RelationshipHost;h.state.byId.get(id).profile.personal.education='=SUM(1,1)';h.refreshAfterMutation('اختبار الجدول',id,{keepView:true});},id);
  await page.click('#advanced-tools summary');await page.click('#export-nodes-csv-btn');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;text=fs.readFileSync(await file.path(),'utf8');assert.equal(text.includes('ID-123456789'),false);assert.equal(text.includes('ملاحظة صحية سرية'),false);assert.equal(text.includes('رقم الهوية'),false);assert.match(text,/منسق اختبار/);assert.match(text,/'=SUM\(1,1\)/);
  await page.click('#advanced-tools summary');await page.click('#export-nodes-csv-btn');await page.check('#export-sensitive');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;text=fs.readFileSync(await file.path(),'utf8');assert.ok(text.includes('رقم الهوية'));assert.ok(text.includes('ID-123456789'));assert.ok(text.includes('ملاحظة صحية سرية'));
  await page.click('#advanced-tools summary');await page.click('#export-svg-btn');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;text=fs.readFileSync(await file.path(),'utf8');assert.equal(text.includes('ID-123456789'),false);
  await page.click('#advanced-tools summary');await page.click('#export-svg-btn');await page.check('#export-sensitive');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;text=fs.readFileSync(await file.path(),'utf8');assert.ok(text.includes('ID-123456789'));assert.ok(text.includes('ملاحظة صحية سرية'));
  await page.click('#advanced-tools summary');await page.click('#export-png-btn');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;let png=fs.readFileSync(await file.path());assert.equal(png.readUInt32BE(20),1520);
  await page.click('#advanced-tools summary');await page.click('#export-png-btn');await page.check('#export-sensitive');dl=page.waitForEvent('download');await page.click('#profile-export-confirm');file=await dl;png=fs.readFileSync(await file.path());assert.ok(png.readUInt32BE(20)>1520);
  // Stub the OS print dialog while checking the actual sandboxed printable document.
  await page.evaluate(()=>{const d=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',{configurable:true,get(){const w=d.get.call(this);if(this.title==='معاينة الطباعة'&&w)w.print=function(){window.__printed=this.document.documentElement.outerHTML;this.dispatchEvent(new this.Event('afterprint'));};return w;}});});
  await page.click('#advanced-tools summary');await page.click('#export-pdf-btn');await page.click('#profile-export-confirm');await page.waitForFunction(()=>!!window.__printed);const safePrintable=await page.evaluate(()=>window.__printed);assert.equal(safePrintable.includes('ID-123456789'),false);const safePdfPage=await browser.newPage();await safePdfPage.setContent(safePrintable);const safePdf=await safePdfPage.pdf({printBackground:true,landscape:true});const safeExtract=require('node:child_process').spawnSync('pdftotext',['-','-'],{input:safePdf});if(!safeExtract.error)assert.equal(safeExtract.stdout.toString().includes('ID-123456789'),false);await safePdfPage.close();
  await page.evaluate(()=>{window.__printed=''});await page.click('#advanced-tools summary');await page.click('#export-pdf-btn');await page.check('#export-sensitive');await page.click('#profile-export-confirm');await page.waitForFunction(()=>!!window.__printed);const printable=await page.evaluate(()=>window.__printed);assert.ok(printable.includes('ID-123456789'));
  const pdfPage=await browser.newPage();await pdfPage.setContent(printable);const pdf=await pdfPage.pdf({printBackground:true,landscape:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');const extract=require('node:child_process').spawnSync('pdftotext',['-','-'],{input:pdf});if(!extract.error)assert.ok(extract.stdout.toString().includes('ID-123456789'),'sensitive appendix should survive PDF rendering');await pdfPage.close();await page.evaluate(()=>{delete window.__printed});
  await page.evaluate(id=>{const h=window.RelationshipHost;h.state.byId.get(id).profile.futureExtension={value:'preserve-unknown-field'};h.state.byId.get(id).profile.personal.futurePersonal='preserve-nested-field';h.refreshAfterMutation('بيانات إضافية',id,{keepView:true});},id);
  await page.click('#advanced-tools summary');await page.click('#backup-json-btn');await page.waitForSelector('#confirm-modal');dl=page.waitForEvent('download');await page.click('#confirm-modal [data-cf="yes"]');file=await dl;text=fs.readFileSync(await file.path(),'utf8');assert.ok(text.includes('ID-123456789'));assert.ok(text.includes('ملاحظة صحية سرية'));assert.ok(text.includes('preserve-unknown-field'));assert.ok(text.includes('preserve-nested-field'));
  await page.click('[data-tab="profile-personal"]');await page.click('[data-profile-edit="personal"]');await page.click('#profile-form button[type="submit"]');assert.equal(await page.evaluate(id=>window.RelationshipHost.state.byId.get(id).profile.personal.futurePersonal,id),'preserve-nested-field');
  await page.click('#advanced-tools summary');await page.click('#compare-tool-btn');await page.click('#run-compare-btn');
  assert.equal((await page.locator('#compare-result').innerText()).includes('ID-123456789'),false);assert.equal((await page.locator('#compare-result').innerText()).includes('ملاحظة صحية سرية'),false);
  await page.locator(`[data-profile-compare="${id}"] [data-profile-reveal="personal.idNumber"]`).click();assert.ok((await page.locator('#compare-result').innerText()).includes('ID-123456789'));
  await page.click('#phase4-modal button[data-phase4-close]');
  await page.waitForTimeout(1600);const api=await (await page.request.get(base+'/api/graph')).json();assert.equal(api.nodes.find(n=>String(n.id)===id).profile.personal.idNumber,'ID-123456789');
  const exp=await (await page.request.get(base+'/api/export')).json();assert.equal(JSON.stringify(exp).includes('ID-123456789'),false);assert.equal(JSON.stringify(exp).includes('ملاحظة صحية سرية'),false);
  // Sensitive search is opt-in for this session; profile filters and map must share the same matches.
  await page.click('#advanced-tools summary');await page.fill('#profile-filter-role','');await page.selectOption('#profile-filter-marital','');await page.selectOption('#profile-filter-health','');
  await page.fill('#search','ID-123456789');assert.equal(await page.evaluate(id=>window.RelationshipHost.state.matchIds.has(id),id),false);
  await page.check('#profile-sensitive-search');assert.equal(await page.evaluate(id=>window.RelationshipHost.state.matchIds.has(id),id),true);
  await page.uncheck('#profile-sensitive-search');await page.fill('#search','');
  await page.click('#advanced-tools summary');await page.evaluate(()=>window.RelationshipMap._setView('map'));await page.fill('#geo-map-search','ID-123456789');await page.click('#geo-search-online');assert.match(await page.locator('#geo-map-results').innerText(),/بيانات حساسة/);await page.evaluate(()=>window.RelationshipMap._setView('graph'));
  // Reopening and saving the same linked row must not create a duplicate edge.
  await page.evaluate(id=>window.RelationshipHost.selectNode(id),id);await page.click('[data-tab="profile-family"]');await page.click('[data-profile-edit="family"]');await page.click('#profile-form button[type="submit"]');
  assert.equal(await page.evaluate(([a,b])=>window.RelationshipHost.state.data.edges.filter(e=>e.type==='Family'&&[String(e.source),String(e.target)].includes(a)&&[String(e.source),String(e.target)].includes(b)).length,[id,other]),1);
  // Deleting the row gives an explicit choice about its edge and is one undoable mutation.
  await page.click('[data-profile-edit="family"]');await page.click('[data-family-remove]');await page.waitForSelector('#confirm-modal');await page.click('#confirm-modal [data-cf="yes"]');await page.click('#profile-form button[type="submit"]');
  assert.equal(await page.evaluate(([a,b])=>window.RelationshipProfile.hasFamilyEdge(window.RelationshipHost.state.data.edges,a,b),[id,other]),false);
  await page.keyboard.press('Control+z');assert.equal(await page.evaluate(([a,b])=>window.RelationshipProfile.hasFamilyEdge(window.RelationshipHost.state.data.edges,a,b),[id,other]),true);
  await page.keyboard.press('Control+y');assert.equal(await page.evaluate(([a,b])=>window.RelationshipProfile.hasFamilyEdge(window.RelationshipHost.state.data.edges,a,b),[id,other]),false);
  await page.keyboard.press('Control+z');assert.equal(await page.evaluate(([a,b])=>window.RelationshipProfile.hasFamilyEdge(window.RelationshipHost.state.data.edges,a,b),[id,other]),true);
  await page.setViewportSize({width:390,height:900});await page.evaluate(id=>window.RelationshipHost.selectNode(id),id);await page.click('[data-tab="profile-family"]');await page.click('[data-profile-edit="family"]');
  const rect=await page.locator('#profile-edit .ev-card').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=391);
  const screenshotDir=path.join(__dirname,'..','docs','screenshots','request4');fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'family-editor-390.png')});
  await page.click('#profile-edit header [data-profile-close]');
  await page.reload();await page.waitForFunction(id=>window.RelationshipHost?.state?.byId?.get(id)?.profile?.personal?.idNumber==='ID-123456789',id);
  await page.evaluate(id=>window.RelationshipHost.selectNode(id),id);await page.click('[data-tab="profile-personal"]');assert.equal(await page.locator('[data-profile-value="personal.idNumber"]').innerText(),'••••6789');
  for(const width of [1440,1100,700,390]){await page.setViewportSize({width,height:900});await page.locator('#detail-content').screenshot({path:path.join(screenshotDir,`personal-panel-${width}.png`)});}
  assert.deepEqual(errors,[]);console.log('Request 4 profile browser checks passed');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
