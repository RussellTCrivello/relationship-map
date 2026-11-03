'use strict';
// Part C: cancellation and retries. Additional multi-area and offline checks belong here as C progresses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-map-c-'));
  Object.assign(process.env, { DB_ENGINE: 'file', DATA_FILE: path.join(tmp, 'db.json'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password-123' });
  await require('../server/auth.js').getAdmin();
  const { app } = require('../server/app.js');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(url => !/^http:\/\/127\.0\.0\.1/.test(url.href) && !/^(data|blob):/.test(url.href), r => r.abort());
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.ok((await page.request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } })).ok());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.RelationshipMap?._state?.base && window.RelationshipHost?.state?.nodes?.length);
    await page.evaluate(() => {
      const native = window.fetch.bind(window); window.__dl = { mode: 'hold', calls: 0 };
      window.fetch = (url, opts) => {
        if (!/overpass/i.test(String(url))) return native(url, opts);
        const d = window.__dl; d.calls++;
        if (d.mode === 'hold') return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        if (d.mode === 'retry' && d.calls === 1) return Promise.resolve(new Response('{}', { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
      window.RelationshipMap._setView('map');
    });
    await page.click('[data-g="setup"]');
    await page.locator('#gs-custom summary').click();
    await page.fill('#gs-lat', '40'); await page.fill('#gs-lng', '-74'); await page.fill('#gs-side', '10');
    const original = await page.evaluate(() => JSON.stringify({ bbox: window.RelationshipMap._state.base.bbox, area: window.RelationshipMap._state.area }));
    const stored = () => page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('relationship-map-geo', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const value = await new Promise((resolve, reject) => { const q = db.transaction('kv').objectStore('kv').get('basemap'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      db.close(); return JSON.stringify(value);
    });
    const originalStored = await stored();
    await page.click('#gs-go'); await page.waitForSelector('#gs-progress:not([hidden])');
    const dir = path.join(__dirname, '..', 'docs', 'screenshots', 'request-2'); fs.mkdirSync(dir, { recursive: true });
    for (const width of [1440, 700, 390]) { await page.setViewportSize({ width, height: 900 }); const rect = await page.locator('#geo-setup .ev-card').boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1); await page.screenshot({ path: path.join(dir, `part-c-download-${width}.png`) }); }
    await page.click('#gs-cancel'); await page.waitForFunction(() => document.querySelector('#gs-status').textContent.includes('إلغاء التنزيل'));
    assert.equal(await page.evaluate(() => JSON.stringify({ bbox: window.RelationshipMap._state.base.bbox, area: window.RelationshipMap._state.area })), original);
    assert.equal(await stored(), originalStored, 'cancel leaves the saved map unchanged');
    assert.equal(await page.evaluate(() => window.__dl.calls), 1);
    await page.evaluate(() => { window.__dl.mode = 'retry'; window.__dl.calls = 0; });
    await page.click('#gs-go');
    await page.waitForFunction(() => document.querySelector('#gs-status').textContent.includes('حُفظت الخريطة'), null, { timeout: 15000 });
    assert.ok(await page.evaluate(() => window.__dl.calls >= 2));
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.area.center.lat), 40);
    const firstId = await page.evaluate(() => window.RelationshipMap._state.activeAreaId);
    assert.notEqual(firstId, 'gaza');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => window.RelationshipMap?._state?.area?.id === id && window.RelationshipMap?._state?.base, firstId);
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.area.center.lat), 40);
    await page.evaluate(() => window.RelationshipMap._setView('map'));
    await page.click('[data-g="setup"]');
    await page.selectOption('#gs-areas', 'gaza'); assert.equal(await page.locator('#gs-delete').isDisabled(), true);
    await page.click('#gs-switch');
    await page.waitForFunction(() => window.RelationshipMap._state.area.id === 'gaza' && window.RelationshipMap._state.base);
    assert.equal(await page.locator('#gs-delete').isDisabled(), true);
    await page.locator('#gs-custom summary').click();
    await page.fill('#gs-name', 'منطقة ثانية'); await page.fill('#gs-lat', '41'); await page.fill('#gs-lng', '-73'); await page.fill('#gs-side', '10');
    await page.click('#gs-save');
    await page.waitForFunction(() => window.RelationshipMap._state.area?.name === 'منطقة ثانية');
    const secondId = await page.evaluate(() => window.RelationshipMap._state.activeAreaId);
    assert.notEqual(secondId, firstId); assert.equal(await page.evaluate(() => window.RelationshipMap._state.base), null);
    assert.equal(await page.locator('#gs-areas option').count(), 3);
    for (const width of [1440, 700, 390]) { await page.setViewportSize({ width, height: 900 }); const rect = await page.locator('#geo-setup .ev-card').boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1); await page.screenshot({ path: path.join(dir, `part-c-areas-${width}.png`) }); }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(id => window.RelationshipMap?._state?.area?.id === id, secondId);
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.base), null);
    await page.evaluate(() => window.RelationshipMap._setView('map'));
    await page.click('[data-g="setup"]');
    assert.equal(await page.locator('#gs-areas option').count(), 3);
    // Chromium is genuinely offline here; switching relies solely on IndexedDB, not mocked network.
    await page.context().setOffline(true);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    await page.waitForSelector('#geo-offline-status:not([hidden])', { state: 'attached' });
    assert.match(await page.locator('#gs-network').innerText(), /دون اتصال/);
    await page.selectOption('#gs-areas', firstId); await page.click('#gs-switch');
    await page.waitForFunction(id => window.RelationshipMap._state.area.id === id && window.RelationshipMap._state.base, firstId);
    await page.selectOption('#gs-areas', 'gaza'); await page.click('#gs-switch');
    await page.waitForFunction(() => window.RelationshipMap._state.area.id === 'gaza' && window.RelationshipMap._state.base);
    await page.context().setOffline(false);
    await page.selectOption('#gs-areas', firstId); await page.click('#gs-switch');
    await page.waitForFunction(id => window.RelationshipMap._state.area.id === id && window.RelationshipMap._state.base, firstId);
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.area.center.lat), 40);
    await page.selectOption('#gs-areas', 'gaza'); await page.click('#gs-switch');
    await page.waitForFunction(() => window.RelationshipMap._state.area.id === 'gaza');
    assert.match(await page.locator('#gs-storage').innerText(), /التخزين|ميغابايت/);
    const backupDownload = page.waitForEvent('download'); await page.click('#gs-backup-export');
    const backupText = fs.readFileSync(await (await backupDownload).path(), 'utf8'), backup = JSON.parse(backupText);
    assert.equal(backup.format, 'relationship-map-areas'); assert.equal(backup.areas.length, 3);
    await page.setInputFiles('#gs-backup-file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
    await page.waitForFunction(() => document.querySelector('#gs-backup-preview').textContent.includes('تعذر قراءة'));
    assert.equal(await page.locator('#gs-areas option').count(), 3);
    await page.setInputFiles('#gs-backup-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
    await page.waitForFunction(() => document.querySelector('#gs-backup-preview').textContent.includes('3 منطقة'));
    assert.equal(await page.locator('#gs-areas option').count(), 3, 'preview does not mutate');
    for (const width of [1440, 700, 390]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: path.join(dir, `part-c-backup-${width}.png`) }); }
    await page.click('#gs-backup-apply');
    await page.waitForFunction(() => window.RelationshipMap._state.areas.length === 6);
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.activeAreaId), 'gaza');
    assert.equal(await page.locator('#gs-areas option').count(), 6);
    const copies = await page.evaluate(([a, b]) => window.RelationshipMap._state.areas.filter(x => !['gaza', a, b].includes(x.id)).map(x => x.id), [firstId, secondId]);
    for (const id of [firstId, secondId, ...copies]) {
      await page.selectOption('#gs-areas', id); await page.click('#gs-delete'); await page.click('#confirm-modal [data-cf="yes"]');
      await page.waitForFunction(id => !window.RelationshipMap._state.areas.some(a => a.id === id), id);
    }
    assert.equal(await page.locator('#gs-areas option').count(), 1);
    assert.equal(await page.locator('#gs-delete').isDisabled(), true);
    assert.deepEqual(errors, []);
    // Upgrade a pre-multi-area IndexedDB profile and verify old keys/data survive.
    const legacyContext = await browser.newContext({ locale: 'ar' });
    const legacyPage = await legacyContext.newPage(); const legacyErrors = [];
    legacyPage.on('pageerror', e => legacyErrors.push(String(e))); legacyPage.on('console', m => { if (m.type() === 'error') legacyErrors.push(m.text()); });
    assert.ok((await legacyPage.request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } })).ok());
    await legacyPage.goto(base + '/assets/css/map.css');
    const G = require('../src/geo'), b = G.bboxAround(36, 33, 10), legacyArea = { name: 'منطقة قديمة', center: { lat: 36, lng: 33 }, bbox: b, sideKm: 10, areaKm2: G.bboxAreaKm2(b), detail: 'basic' }, legacyMap = G.parseOverpass({ elements: [] }, b, { detail: 'basic' });
    await legacyPage.evaluate(async ([area, map]) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('relationship-map-geo', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(area, 'area'); t.objectStore('kv').put(map, 'basemap'); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); db.close();
    }, [legacyArea, legacyMap]);
    await legacyPage.goto(base, { waitUntil: 'domcontentloaded' });
    await legacyPage.waitForFunction(() => window.RelationshipMap?._state?.area?.id === 'legacy' && window.RelationshipMap?._state?.base);
    assert.equal(await legacyPage.evaluate(() => window.RelationshipMap._state.area.name), 'منطقة قديمة');
    const migrated = await legacyPage.evaluate(async () => { const db = await new Promise(resolve => { const q = indexedDB.open('relationship-map-geo', 1); q.onsuccess = () => resolve(q.result); }); const tx = db.transaction('kv'); return await Promise.all(['area', 'basemap', 'area:gaza', 'area:legacy', 'basemap:legacy'].map(k => new Promise(resolve => { const q = tx.objectStore('kv').get(k); q.onsuccess = () => resolve(q.result); }))); });
    assert.equal(migrated[0].name, 'منطقة قديمة'); assert.deepEqual(migrated[1].bbox, b); assert.ok(migrated[2].builtin); assert.equal(migrated[3].id, 'legacy'); assert.deepEqual(migrated[4].bbox, b);
    assert.deepEqual(legacyErrors, []); await legacyContext.close();
    console.log('Request 2 Part C incremental browser check passed (cancel, retry, multi-area, migration, backup and offline switching; Electron pending)');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
