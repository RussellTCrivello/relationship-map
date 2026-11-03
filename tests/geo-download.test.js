'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geo.js');
const D = require('../src/geo-download.js');
const bbox = G.bboxAround(31.5, 34.4, 10);
const success = () => ({ ok: true, json: async () => ({ elements: [] }) });
const options = extra => ({ bbox, detail: 'basic', geo: G, mirrors: ['a', 'b', 'c'], fetcher: async () => success(), wait: async () => {}, ...extra });
test('download retries mirrors with bounded backoff and returns a validated map', async () => {
  const urls = [], waits = [], states = [];
  const map = await D.fetchBasemap(options({ fetcher: async url => { urls.push(url); if (url === 'a') return { ok: false, status: 503 }; if (url === 'b') return { ok: true, json: async () => ({ bad: true }) }; return success(); }, wait: async ms => waits.push(ms), onStatus: s => states.push(s) }));
  assert.deepEqual(urls, ['a', 'b', 'c']); assert.deepEqual(waits.slice(0, 2), [100, 200]); assert.equal(map.v, 2); assert.ok(states.some(s => s.includes('إعادة المحاولة')));
});
test('user abort interrupts the current fetch and never tries another mirror', async () => {
  const c = new AbortController(); let calls = 0;
  const result = D.fetchBasemap(options({ signal: c.signal, fetcher: async (_, opts) => { calls++; return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))); } }));
  c.abort(); await assert.rejects(result, { name: 'AbortError' }); assert.equal(calls, 1);
});
test('user abort interrupts backoff', async () => {
  const c = new AbortController(); let calls = 0;
  const result = D.fetchBasemap(options({ signal: c.signal, fetcher: async () => { calls++; return { ok: false, status: 503 }; }, wait: D.delay, backoff: [10000] }));
  setTimeout(() => c.abort(), 20); await assert.rejects(result, { name: 'AbortError' }); assert.equal(calls, 1);
});
test('timeouts fall through mirrors but exhausted downloads fail without returning partial maps', async () => {
  let calls = 0;
  const result = D.fetchBasemap(options({ timeoutMs: 5, fetcher: async (_, opts) => { calls++; return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('timeout')))); } }));
  await assert.rejects(result, /مهلة/); assert.equal(calls, 3);
});
