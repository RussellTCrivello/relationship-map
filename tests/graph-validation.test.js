const test = require('node:test'); const assert = require('node:assert/strict');
// Unit-level contract tests for the graph payload accepted by the API.
function valid(g){const ids=new Set();for(const n of g.nodes){if(n.id==null||!(n.label||n.name)||ids.has(String(n.id)))return false;ids.add(String(n.id));}const eids=new Set();for(const e of g.edges){if(e.id==null||eids.has(String(e.id))||!ids.has(String(e.source))||!ids.has(String(e.target)))return false;eids.add(String(e.id));}return true;}
test('accepts a valid graph',()=>assert.equal(valid({nodes:[{id:1,label:'A'},{id:2,label:'B'}],edges:[{id:9,source:1,target:2}]}),true));
test('rejects dangling relationships',()=>assert.equal(valid({nodes:[{id:1,label:'A'}],edges:[{id:9,source:1,target:2}]}),false));
test('rejects duplicate entity identifiers',()=>assert.equal(valid({nodes:[{id:1,label:'A'},{id:1,label:'B'}],edges:[]}),false));
