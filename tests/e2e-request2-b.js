'use strict';
// Request 2 Part B: incremental browser check for local/online map search.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-map-search-'));
  Object.assign(process.env, { DB_ENGINE: 'file', DATA_FILE: path.join(tmp, 'db.json'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password-123' });
  await require('../server/auth.js').getAdmin();
  const { app } = require('../server/app.js');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route(url => !/^http:\/\/127\.0\.0\.1/.test(url.href) && !/^(data|blob):/.test(url.href), route => route.abort());
  let fail = false;
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(fail ? null : [{ lat: '31.501', lon: '34.402', name: 'مكان اختباري', display_name: 'مكان اختباري، غزة' }]) }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await page.request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } }); assert.ok(login.ok());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.RelationshipHost?.state?.nodes?.some(n => n.schema !== 'Event'));
    const id = await page.evaluate(() => {
      const h = window.RelationshipHost, n = h.state.data.nodes.find(n => n.schema !== 'Event');
      n.label = 'أَحمد الاختبار'; n.geo = { lat: 31.5, lng: 34.4, place: 'غزة القديمة', photos: [] };
      n.events = [{ id: 'search-event', title: 'إجتماع مهم', type: 'meeting', datePrecision: 'unknown', geo: { lat: 31.501, lng: 34.401, place: 'الميناء' } }];
      h.refreshAfterMutation('بحث تجريبي', String(n.id), { keepView: true });
      const m = window.RelationshipMap; Object.assign(m._state, { lat: 31.5, lng: 34.4, z: 16 }); m._setView('map'); m.sync(true);
      return String(n.id);
    });
    await page.fill('#geo-map-search', 'احمد الاختبار');
    assert.equal(await page.locator('#geo-map-results [data-map-result]').count(), 2);
    await page.fill('#geo-map-search', 'اجتماع');
    assert.equal(await page.locator('#geo-map-results [data-map-result]').count(), 1);
    await page.click('#geo-map-results [data-map-result="0"]');
    await page.waitForSelector('#geo-card:not([hidden])');
    assert.match(await page.locator('#geo-card').innerText(), /إجتماع مهم/);
    assert.equal(await page.evaluate(() => window.RelationshipHost.state.selected), id);
    await page.fill('#geo-map-search', 'مكان اختبار'); await page.click('#geo-search-online');
    await page.waitForSelector('#geo-map-results [data-online-result]');
    assert.match(await page.locator('#geo-map-results').innerText(), /مكان اختباري/);
    await page.click('#geo-map-results [data-online-add]');
    await page.waitForSelector('#geo-edit.open');
    assert.equal(await page.inputValue('#geo-edit #gx-place'), 'مكان اختباري');
    await page.click('#geo-edit header [data-m-close]');
    fail = true; await page.click('#geo-search-online');
    await page.waitForSelector('#geo-map-results [role="alert"]');
    assert.match(await page.locator('#geo-map-results [role="alert"]').innerText(), /تعذر البحث/);
    const savedZone = page.waitForResponse(r => r.url().endsWith('/api/graph') && r.request().method() === 'PUT' && (r.request().postData() || '').includes('test-zone') && r.status() === 200, { timeout: 15000 });
    await page.evaluate(id => {
      const h = window.RelationshipHost;
      h.state.data.zones.push({ id: 'test-zone', name: 'منطقة محفوظة', color: '#d4ff3f', shape: 'circle', center: { lat: 31.5, lng: 34.4 }, radius: 250, note: '', photos: [], link: { nodeId: id } });
      h.refreshAfterMutation('منطقة اختبار', id, { keepView: true });
    }, id);
    await savedZone;
    const graph = await (await page.request.get(base + '/api/graph')).json();
    assert.ok(graph.zones.some(z => z.id === 'test-zone'));
    await page.reload();
    await page.waitForFunction(() => window.RelationshipHost?.state?.data?.zones?.some(z => z.id === 'test-zone'));
    await page.evaluate(id => {
      const h = window.RelationshipHost;
      h.state.data.zones.push({ id: 'undo-zone', name: 'للتراجع', color: '#2ee59d', shape: 'rectangle', points: [{ lat: 31.5, lng: 34.4 }, { lat: 31.51, lng: 34.41 }], photos: [] });
      h.refreshAfterMutation('منطقة ثانية', id, { keepView: true });
    }, id);
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => window.RelationshipHost.state.data.zones.map(z => z.id)), ['test-zone']);
    await page.evaluate(() => { const m = window.RelationshipMap; cancelAnimationFrame(m._state.fly); Object.assign(m._state, { fly: 0, lat: 31.5, lng: 34.4, z: 16 }); m._setView('map'); m.sync(true); });
    await page.click('[data-g="zone"]'); await page.click('[data-zone-shape="polygon"]');
    const rect = await page.locator('#geo-canvas').boundingBox();
    const pt = (x, y) => ({ x: rect.x + x, y: rect.y + y });
    const a = pt(400, 270), b = pt(650, 270), c = pt(550, 470);
    await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y); await page.mouse.dblclick(c.x, c.y, { delay: 30 });
    await page.waitForSelector('#geo-zone-edit.open');
    await page.fill('#gz-name', 'مضلع تجريبي'); await page.fill('#gz-note', 'منطقة للتجربة');
    await page.click('#geo-zone-edit button[type="submit"]');
    await page.waitForSelector('#geo-zone-edit:not(.open)', { state: 'attached' });
    assert.equal(await page.evaluate(() => window.RelationshipHost.state.data.zones.find(z => z.name === 'مضلع تجريبي').points.length), 3);
    await page.waitForSelector('#geo-card [data-zone-shape-edit]');
    await page.click('#geo-card [data-zone-shape-edit]');
    const original = await page.evaluate(() => ({ ...window.RelationshipMap._state.zoneEdit.points[0] }));
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 20, a.y + 15, { steps: 4 }); await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => window.RelationshipMap._state.zoneEdit.points[0]), original);
    const edge = await page.evaluate(() => {
      const m = window.RelationshipMap._state, g = window.RelationshipGeo, r = document.querySelector('#geo-canvas').getBoundingClientRect();
      const center = g.project(m.lat, m.lng, m.z), verts = m.zoneEdit.points.slice(0, 2).map(p => g.project(p.lat, p.lng, m.z));
      return { x: r.x + (verts[0].x + verts[1].x) / 2 - center.x + m.w / 2, y: r.y + (verts[0].y + verts[1].y) / 2 - center.y + m.h / 2 };
    }); await page.mouse.click(edge.x, edge.y);
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.zoneEdit.points.length), 4);
    await page.mouse.click(edge.x, edge.y, { button: 'right' });
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.zoneEdit.points.length), 3);
    await page.getByRole('button', { name: 'حفظ الشكل' }).click();
    assert.notDeepEqual(await page.evaluate(() => window.RelationshipHost.state.data.zones.find(z => z.name === 'مضلع تجريبي').points[0]), original);
    await page.click('[data-g="zone"]'); await page.click('[data-zone-shape="circle"]');
    await page.mouse.click(rect.x + 700, rect.y + 220); await page.mouse.click(rect.x + 750, rect.y + 220);
    await page.waitForSelector('#geo-zone-edit.open'); await page.fill('#gz-name', 'دائرة تجريبية'); await page.click('#geo-zone-edit button[type="submit"]');
    await page.waitForSelector('#geo-zone-edit:not(.open)', { state: 'attached' });
    assert.ok(await page.evaluate(() => window.RelationshipHost.state.data.zones.find(z => z.name === 'دائرة تجريبية').radius > 0));
    await page.click('[data-g="zone"]'); await page.click('[data-zone-shape="rectangle"]');
    await page.mouse.click(rect.x + 500, rect.y + 300); await page.mouse.click(rect.x + 700, rect.y + 430);
    await page.waitForSelector('#geo-zone-edit.open'); await page.fill('#gz-name', 'مستطيل تجريبي');
    await page.fill('#gz-note', 'حدود المنطقة'); await page.selectOption('#gz-link', `n:${id}`);
    await page.locator('#gz-photos #gx-file').setInputFiles(path.join(__dirname, 'fixtures', 'location.png'));
    await page.waitForSelector('#gz-photos [data-cap="0"]'); await page.fill('#gz-photos [data-cap="0"]', 'صورة المنطقة');
    await page.click('#geo-zone-edit button[type="submit"]');
    await page.waitForSelector('#geo-zone-edit:not(.open)', { state: 'attached' });
    assert.equal(await page.evaluate(() => window.RelationshipHost.state.data.zones.find(z => z.name === 'مستطيل تجريبي').shape), 'rectangle');
    await page.evaluate(id => {
      const h = window.RelationshipHost, zone = h.state.data.zones.find(z => z.name === 'مستطيل تجريبي');
      const a = zone.points[0], b = zone.points[1];
      h.state.data.nodes.push({ id: h.nextId(h.state.data.nodes), label: 'كيان داخل المنطقة', schema: 'Person', geo: { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2, photos: [] } });
      h.refreshAfterMutation('إضافة كيان داخلي', id, { keepView: true });
    }, id);
    await page.waitForFunction(() => document.querySelector('#geo-card')?.textContent.includes('كيان داخل المنطقة'));
    assert.match(await page.locator('#geo-card').innerText(), /حدود المنطقة/);
    assert.match(await page.locator('#geo-card').innerText(), /داخل هذه المنطقة/);
    assert.match(await page.locator('#geo-card').innerText(), /صورة المنطقة/);
    assert.equal(await page.locator('#geo-card [data-zone-photo]').count(), 1);
    const screenshots = path.join(__dirname, '..', 'docs', 'screenshots', 'request-2'); fs.mkdirSync(screenshots, { recursive: true });
    for (const width of [1440, 700, 390]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(100);
      const overlap = await page.evaluate(() => {
        const a = document.querySelector('#geo-card').getBoundingClientRect(), b = document.querySelector('.geo-controls').getBoundingClientRect(), c = document.querySelector('#geo-map-searchbox').getBoundingClientRect();
        const hit = (x, y) => x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
        return hit(a, b) || hit(a, c);
      });
      assert.equal(overlap, false, `map card overlaps controls at ${width}px`);
      await page.screenshot({ path: path.join(screenshots, `part-b-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#geo-card [data-zone-close]');
    const zonePoint = await page.evaluate(() => {
      const m = window.RelationshipMap._state, g = window.RelationshipGeo, z = window.RelationshipHost.state.data.zones.find(z => z.name === 'مستطيل تجريبي');
      const a = z.points[0], b = z.points[1], p = g.project(a.lat * .75 + b.lat * .25, a.lng * .75 + b.lng * .25, m.z), center = g.project(m.lat, m.lng, m.z), r = document.querySelector('#geo-canvas').getBoundingClientRect();
      return { x: r.x + p.x - center.x + m.w / 2, y: r.y + p.y - center.y + m.h / 2 };
    });
    await page.mouse.click(zonePoint.x, zonePoint.y);
    await page.waitForSelector('#geo-card [data-zone-delete]');
    await page.click('#geo-filter-btn');
    await page.uncheck('[data-filter-kind="zones"]');
    await page.waitForSelector('#geo-card[hidden]', { state: 'attached' });
    await page.check('[data-filter-kind="zones"]');
    await page.waitForSelector('#geo-card:not([hidden])');
    await page.click('#geo-filter-btn');
    await page.click('#geo-card [data-zone-delete]'); await page.click('#confirm-modal [data-cf="yes"]');
    await page.waitForFunction(() => !window.RelationshipHost.state.data.zones.some(z => z.name === 'مستطيل تجريبي'));
    await page.keyboard.press('Control+z');
    assert.ok(await page.evaluate(() => window.RelationshipHost.state.data.zones.some(z => z.name === 'مستطيل تجريبي')));
    const zoneSave = page.waitForResponse(r => r.url().endsWith('/api/graph') && r.request().method() === 'PUT' && (r.request().postData() || '').includes('مستطيل تجريبي') && r.status() === 200, { timeout: 15000 });
    await zoneSave;
    const stored = await (await page.request.get(base + '/api/graph')).json();
    assert.equal(stored.zones.find(z => z.name === 'مستطيل تجريبي').photos[0].caption, 'صورة المنطقة');
    await page.reload();
    await page.waitForFunction(() => window.RelationshipHost?.state?.data?.zones?.some(z => z.name === 'مستطيل تجريبي'));
    await page.click('[data-g="zone"]'); await page.click('[data-zone-io]');
    await page.check('#gio-photos');
    const jsonDownload = page.waitForEvent('download'); await page.click('[data-io-export="geojson"]');
    const json = JSON.parse(fs.readFileSync(await (await jsonDownload).path(), 'utf8'));
    assert.ok(json.features.some(f => f.geometry.type === 'Polygon' && f.properties.name === 'مستطيل تجريبي'));
    assert.ok(JSON.stringify(json).includes('data:image'));
    const kmlDownload = page.waitForEvent('download'); await page.click('[data-io-export="kml"]');
    const kml = fs.readFileSync(await (await kmlDownload).path(), 'utf8');
    assert.ok(kml.includes('<kml')); assert.ok(require('../src/geo-io').parseKML(kml, { photos: true }).zones.length >= 1);
    await page.setInputFiles('#gio-file', { name: 'too-large.geojson', mimeType: 'application/json', buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 32) });
    assert.match(await page.locator('#gio-error').innerText(), /10/); assert.equal(await page.locator('#gio-apply').isDisabled(), true);
    const feature = { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: '<img src=x onerror=alert(1)>', description: 'safe' }, geometry: { type: 'Point', coordinates: [34.4, 31.5] } },
      { type: 'Feature', properties: { name: 'منطقة مستوردة' }, geometry: { type: 'Polygon', coordinates: [[[34,31],[35,31],[35,32],[34,31]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[34,31],[35,32]] } },
    ] };
    const oldCounts = await page.evaluate(() => ({ nodes: window.RelationshipHost.state.data.nodes.length, zones: window.RelationshipHost.state.data.zones.length }));
    await page.setInputFiles('#gio-file', { name: 'test.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(feature)) });
    await page.waitForFunction(() => document.querySelector('#gio-preview')?.textContent.includes('منطقة مستوردة'));
    assert.match(await page.locator('#gio-preview').innerText(), /تم تجاهل 1/);
    assert.equal(await page.locator('#gio-preview img').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ nodes: window.RelationshipHost.state.data.nodes.length, zones: window.RelationshipHost.state.data.zones.length })), oldCounts);
    for (const width of [1440, 700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const r = await page.locator('#geo-io .ev-card').boundingBox();
      assert.ok(r.x >= 0 && r.x + r.width <= width + 1, `interchange dialog fits ${width}px`);
      await page.screenshot({ path: path.join(screenshots, `part-b-io-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#gio-apply');
    assert.equal(await page.evaluate(() => window.RelationshipHost.state.data.nodes.length), oldCounts.nodes + 1);
    assert.equal(await page.evaluate(() => window.RelationshipHost.state.data.zones.length), oldCounts.zones + 1);
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => ({ nodes: window.RelationshipHost.state.data.nodes.length, zones: window.RelationshipHost.state.data.zones.length })), oldCounts);
    await page.click('[data-g="zone"]'); await page.click('[data-zone-io]'); await page.check('#gio-photos');
    await page.setInputFiles('#gio-file', { name: 'export.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(kml) });
    await page.waitForFunction(() => document.querySelector('#gio-preview')?.textContent.includes('مستطيل تجريبي'));
    await page.click('#gio-apply');
    assert.ok(await page.evaluate(n => window.RelationshipHost.state.data.zones.length > n, oldCounts.zones));
    await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(() => ({ nodes: window.RelationshipHost.state.data.nodes.length, zones: window.RelationshipHost.state.data.zones.length })), oldCounts);
    assert.deepEqual(errors, []);
    console.log('Request 2 Part B browser check passed (search, zones and interchange)');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
