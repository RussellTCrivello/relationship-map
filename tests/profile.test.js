'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const P=require('../src/profile.js');

test('profile normalization trims fields, drops empty values and bounds lists and text',()=>{
  assert.equal(P.normalizeProfile({personal:{phone:'   '},family:[{id:'x'}],health:{conditions:[' ','']}}),undefined);
  assert.equal(P.isEmptyProfile({role:{title:''}}),true);
  const p=P.normalizeProfile({personal:{birthPlace:' Gaza ',notes:'x'.repeat(4100),phone:' 12345 '},role:{title:' مدير '},family:[{name:' Alice ',relation:'أخت',phone:' 55555 '},{id:'empty'}],health:{conditions:[' حساسية ','', 'ربو']}});
  assert.equal(p.personal.birthPlace,'Gaza'); assert.equal(p.personal.notes.length,4000);
  assert.equal(p.personal.phone,'12345'); assert.equal(p.role.title,'مدير'); assert.equal(p.family.length,1);
  assert.equal(p.family[0].id,'f1'); assert.deepEqual(p.health.conditions,['حساسية','ربو']);
  assert.equal(P.normalizeProfile({family:Array.from({length:110},(_,i)=>({name:String(i)}))}).family.length,100);
  assert.equal(P.normalizeProfile({health:{conditions:Array.from({length:60},(_,i)=>String(i))}}).health.conditions.length,50);
  const text=JSON.stringify(p); assert.equal(text.includes(':""'),false); assert.equal(text.includes(':[]'),false);
});

test('partial, exact, invalid and future birth dates use chronology semantics',()=>{
  const today=new Date(2026,10,2,12);
  assert.deepEqual(P.ageFromBirthDate('2000',today),{age:26,approximate:true});
  assert.deepEqual(P.ageFromBirthDate('2000-12',today),{age:25,approximate:true});
  assert.deepEqual(P.ageFromBirthDate('2000-11-03',today),{age:25,approximate:false});
  assert.deepEqual(P.ageFromBirthDate('2000-11-02',today),{age:26,approximate:false});
  for(const v of ['2027','2026-12','2026-11-03','2000-02-30','invalid']) assert.equal(P.ageFromBirthDate(v,today),null,v);
});

test('fixed relation, marital and health choices and Arabic errors',()=>{
  assert.deepEqual(P.validateProfile({maritalStatus:'married',health:{status:'جيدة'},family:[{relation:'أم',status:'متوفى',birthDate:'1980-02'}]}),[]);
  const errors=P.validateProfile({maritalStatus:'bad',health:{status:'bad',lastCheck:'2020-44'},family:[{relation:'أخرى'}]});
  assert.equal(errors.length,4); assert.ok(errors.every(x=>/[\u0600-\u06ff]/.test(x)));
  assert.equal(P.normalizeProfile({maritalStatus:'bad',health:{status:'bad'},family:[{relation:'bad'}]}),undefined);
  assert.equal(P.validateProfile({family:Array.from({length:101},()=>({}))}).length,1);
});

test('masking never exposes full short identifiers',()=>{
  assert.equal(P.maskId('123456789'),'••••6789'); assert.equal(P.maskPhone(' 12345 '),'••••2345');
  assert.equal(P.maskId('1234'),'••••'); assert.equal(P.maskPhone(''),'');
});

test('reciprocal relations use known gender and avoid assumptions',()=>{
  assert.equal(P.reciprocalRelation('أب','أنثى'),'ابنة'); assert.equal(P.reciprocalRelation('أم','ذكر'),'ابن');
  assert.equal(P.reciprocalRelation('ابنة','أنثى'),'أم'); assert.equal(P.reciprocalRelation('أخ','ذكر'),'أخ');
  assert.equal(P.reciprocalRelation('أخ','أنثى'),'أخت'); assert.equal(P.reciprocalRelation('زوج','أنثى'),'زوجة');
  assert.equal(P.reciprocalRelation('أب',''),null); assert.equal(P.reciprocalRelation('عم','ذكر'),null);
});

test('family edge detection is undirected, type-specific and does not mutate data',()=>{
  const edges=[{source:'a',target:'b',type:'Family'},{source:'a',target:'c',type:'Associate'}];
  assert.equal(P.hasFamilyEdge(edges,'b','a'),true); assert.equal(P.hasFamilyEdge(edges,'a','c'),false); assert.equal(edges.length,2);
});

test('export is fail-closed for profile secrets without mutating originals',()=>{
  const p={personal:{birthPlace:'غزة',idNumber:'secretID',phone:'secretPhone',phone2:'secretPhone2',email:'secretMail'},family:[{id:'1',relation:'أم',name:'ن',phone:'secretFamily'}],health:{status:'جيدة',notes:'secretHealth'},role:{title:'عضو'}};
  const copy=structuredClone(p), safe=P.exportProfile(p), text=JSON.stringify(safe);
  for(const secret of ['secretID','secretPhone','secretPhone2','secretMail','secretFamily','secretHealth']) assert.equal(text.includes(secret),false,secret);
  assert.deepEqual(p,copy); assert.deepEqual(P.exportProfile(p,true),p);
  assert.equal(P.exportProfile({health:{notes:'secret'}}),undefined);
});

test('online searches are blocked when they contain saved sensitive profile data',()=>{
 const nodes=[{profile:{personal:{idNumber:'AB12345678',phone:'+970 555 1234',email:'person@example.test'},family:[{phone:'052 555 1111'}],health:{conditions:['حالة سرية'],notes:'تفاصيل طبية خاصة'}}}];
 for(const q of ['AB12345678','person@example.test','9705551234','0525551111','حالة سرية','تفاصيل طبية'])assert.equal(P.hasSensitiveQuery(nodes,q),true,q);
 assert.equal(P.hasSensitiveQuery(nodes,'غزة'),false);
});
