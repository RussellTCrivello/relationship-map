'use strict';
// Isolated Electron profile checks persistence across a real application restart (Linux/Xvfb).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron:electron}=require('playwright');const root=path.join(__dirname,'..');
async function run(){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rm-profile-electron-'));
 const binary=process.env.ELECTRON_BINARY||require(require.resolve('electron',{paths:[path.join(root,'desktop')]}));
 const env={...process.env,NODE_OPTIONS:'',XDG_CONFIG_HOME:path.join(tmp,'config'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password-123',ELECTRON_DISABLE_SANDBOX:'1'};delete env.ELECTRON_RUN_AS_NODE;
 let current;
 const launch=async()=>{
  const app=await electron.launch({executablePath:binary,args:['--no-sandbox',path.join(root,'desktop/main.js')],env,timeout:45000});
  try{
   const userData=await app.evaluate(({app})=>app.getPath('userData'));assert.ok(userData.startsWith(tmp));
   const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:47831/**');
   const login=await page.request.post('http://127.0.0.1:47831/api/auth/login',{data:{username:'admin',password:'test-password-123'}});assert.ok(login.ok());
   await page.goto('http://127.0.0.1:47831/',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.RelationshipHost?.state?.nodes?.length);
   return {app,page,userData};
  }catch(e){await app.close();throw e;}
 };
 try{
  console.log('Electron launch 1');current=await launch();console.log('Electron ready 1');const id=await current.page.evaluate(()=>String(window.RelationshipHost.state.nodes[0].id));
  await current.page.evaluate(id=>window.RelationshipHost.selectNode(id),id);await current.page.click('[data-tab="profile-personal"]');await current.page.click('[data-profile-edit="personal"]');
  await current.page.fill('[name="personal.idNumber"]','ELECTRON-123456');await current.page.fill('[name="role.title"]','دور سطح المكتب');await current.page.click('#profile-form button[type="submit"]');
  console.log('Profile saved in form');await current.page.waitForFunction(async id=>{const r=await fetch('/api/graph');const x=await r.json();return x.nodes.find(n=>String(n.id)===id)?.profile?.role?.title==='دور سطح المكتب';},id);
  console.log('Saved to database');await current.page.waitForFunction(()=>document.querySelector('#storage-state')?.textContent.includes('محفوظ في قاعدة البيانات'));const userData=current.userData;await current.app.close();current=null;console.log('Electron launch 2');current=await launch();console.log('Electron ready 2');assert.equal(current.userData,userData);
  await current.page.evaluate(id=>window.RelationshipHost.selectNode(id),id);await current.page.click('[data-tab="profile-personal"]');assert.equal(await current.page.locator('[data-profile-value="personal.idNumber"]').innerText(),'••••3456');
  await current.page.locator('[data-profile-reveal="personal.idNumber"]').click();assert.equal(await current.page.locator('[data-profile-value="personal.idNumber"]').innerText(),'ELECTRON-123456');
  console.log('Request 4 Electron profile persistence, masking and restart passed');
 }finally{if(current)await current.app.close();fs.rmSync(tmp,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1});
