'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pool,_reset}=require('../server/file-pool');
test('corrupt storage is never replaced with empty state and recovery keeps a valid backup',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profile-store-'));const file=path.join(dir,'data.json');process.env.DATA_FILE=file;
 const secret='SECRET_IN_CORRUPT_RECORD';let logs=[];const warn=console.warn;console.warn=(...args)=>logs.push(args.join(' '));
 try{
  fs.writeFileSync(file,`{"secret":"${secret}",`);_reset();
  await assert.rejects(pool.query('SELECT 1'),/لم يُستبدل/);assert.ok(fs.readFileSync(file,'utf8').includes(secret));assert.ok(logs.every(x=>!x.includes(secret)));
  const safe=JSON.stringify({meta:{revision:7,last_request_id:null,zones:[]},entities:[],relationships:[],layout:null,admin:null,sessions:[]});fs.writeFileSync(file+'.bak',safe);_reset();
  assert.equal((await pool.query('SELECT revision FROM graph_meta WHERE id=1')).rows[0].revision,7);
  await pool.query('UPDATE graph_meta SET revision=0, last_request_id=NULL WHERE id=1');
  assert.equal(fs.readFileSync(file+'.bak','utf8'),safe);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).meta.revision,0);
 }finally{console.warn=warn;_reset();delete process.env.DATA_FILE;fs.rmSync(dir,{recursive:true,force:true});}
});
