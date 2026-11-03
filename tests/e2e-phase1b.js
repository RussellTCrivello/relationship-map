'use strict';
// End-to-end Playwright test for Request 1B: richer area/landmark labels, v2 basemap, automatic install
// of the bundled Gaza vector map, name-language and per-class toggles, v1 compatibility and the
// background-Overpass fallback. Screenshots at 1440 / 700 / 390 px.
//
// Every stage runs in its own browser context so IndexedDB / localStorage are truly empty ("fresh install").
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('/tmp/pw/node_modules/playwright'));
}

const tilesMod = require('../server/tiles.js');
const vectormapMod = require('../server/vectormap.js');

const ROOT = path.resolve(__dirname, '..');
const PACK_PATH = path.join(ROOT, 'offline_map', 'gaza.tilepack');
const VECTORMAP_PATH = path.join(ROOT, 'offline_map', 'gaza.vectormap.json');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/phase1b-screenshots';
const GAZA = { s: 31.199587, w: 34.208336, n: 31.610411, e: 34.581528 };

// Mocked Overpass payload for the automatic background download: one element of every label class.
const MOCK_OVERPASS = {
  elements: [
    { type: 'node', id: 201, lat: 31.516, lon: 34.458, tags: { place: 'city', name: 'غزة', 'name:en': 'Gaza' } },
    { type: 'node', id: 202, lat: 31.535, lon: 34.483, tags: { place: 'town', name: 'جباليا', 'name:en': 'Jabalia' } },
    { type: 'node', id: 203, lat: 31.448, lon: 34.392, tags: { place: 'town', name: 'النصيرات', 'name:en': 'Nuseirat' } },
    { type: 'node', id: 204, lat: 31.418, lon: 34.351, tags: { place: 'village', name: 'المغازي', 'name:en': 'Al Maghazi' } },
    { type: 'node', id: 211, lat: 31.503, lon: 34.442, tags: { place: 'quarter', name: 'حارة الدرج', 'name:en': 'Ad Darraj' } },
    { type: 'node', id: 212, lat: 31.511, lon: 34.446, tags: { place: 'neighbourhood', name: 'الشجاعية', 'name:en': "Shuja'iyya" } },
    { type: 'node', id: 213, lat: 31.462, lon: 34.395, tags: { place: 'suburb', name: 'Nuseirat Refugee Camp', 'name:en': 'Nuseirat Refugee Camp' } },
    { type: 'node', id: 214, lat: 31.3, lon: 34.25, tags: { natural: 'sea', name: 'البحر الأبيض المتوسط', 'name:en': 'Mediterranean Sea' } },
    { type: 'node', id: 215, lat: 31.505, lon: 34.45, tags: { amenity: 'hospital', name: 'مستشفى الشفاء', 'name:en': 'Al-Shifa Hospital' } },
    { type: 'node', id: 216, lat: 31.52, lon: 34.44, tags: { amenity: 'university', name: 'الجامعة الإسلامية', 'name:en': 'Islamic University' } },
    { type: 'node', id: 217, lat: 31.5, lon: 34.47, tags: { amenity: 'marketplace', name: 'سوق الشجاعية', 'name:en': 'Shujaiyya Market' } },
    { type: 'node', id: 218, lat: 31.49, lon: 34.44, tags: { leisure: 'park', name: 'حديقة الجندي المجهول', 'name:en': 'Unknown Soldier Park' } },
    { type: 'node', id: 219, lat: 31.48, lon: 34.43, tags: { natural: 'beach', name: 'شاطئ غزة', 'name:en': 'Gaza Beach' } },
    {
      type: 'relation', id: 4710, center: { lat: 31.42, lon: 34.37 },
      tags: { type: 'boundary', boundary: 'administrative', admin_level: '6', name: 'محافظة غزة', 'name:en': 'Gaza Governorate' },
    },
    {
      type: 'way', id: 500,
      geometry: [
        { lat: 31.48, lon: 34.46 }, { lat: 31.48, lon: 34.44 }, { lat: 31.5, lon: 34.44 },
        { lat: 31.5, lon: 34.46 }, { lat: 31.48, lon: 34.46 },
      ],
      tags: { leisure: 'park', name: 'متنزه غزة', 'name:en': 'Gaza Park' },
    },
    {
      type: 'way', id: 300,
      geometry: [{ lat: 31.26, lon: 34.27 }, { lat: 31.42, lon: 34.37 }, { lat: 31.55, lon: 34.51 }],
      tags: { highway: 'trunk', name: 'شارع صلاح الدين' },
    },
  ],
};

function v1Basemap() {
  const pack = (pts) => {
    const out = []; let pl = 0, pg = 0;
    for (const [lat, lng] of pts) { const a = Math.round(lat * 1e5), g = Math.round(lng * 1e5); out.push(a - pl, g - pg); pl = a; pg = g; }
    return out;
  };
  return {
    v: 1,
    bbox: { ...GAZA },
    created: '2024-01-01T00:00:00.000Z',
    source: '© OpenStreetMap contributors',
    detail: 'basic',
    roads: [{ k: 'major', n: 'شارع صلاح الدين', p: pack([[31.26, 34.27], [31.42, 34.37], [31.55, 34.51]]) }],
    rail: [], water: [], waterLines: [], green: [],
    places: [{ n: 'غزة', t: 'city', lat: 31.516, lng: 34.458 }],
  };
}

async function run() {
  assert.ok(fs.existsSync(PACK_PATH), `Expected tilepack at ${PACK_PATH} (run npm run prepare-app first)`);
  assert.ok(fs.existsSync(VECTORMAP_PATH), `Expected bundled vector map at ${VECTORMAP_PATH} (run npm run build:vectormap first)`);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-e2e-phase1b-'));
  process.env.DB_ENGINE = 'file';
  process.env.DATA_FILE = path.join(tmpDir, 'db.json');
  process.env.OFFLINE_TILES_FILE = PACK_PATH;
  process.env.OFFLINE_VECTORMAP_FILE = VECTORMAP_PATH;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password-123';
  tilesMod._reset();
  vectormapMod._reset();

  const { pool, _reset } = require('../server/file-pool.js');
  _reset?.();
  const { getAdmin } = require('../server/auth.js');
  await getAdmin();
  const { app } = require('../server/app.js');
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];
  const consoleErrors = [];
  const overpass = { delay: 0, requests: 0, mode: 'mock' };

  // Opens a brand-new, empty profile and signs in.
  async function openApp({ viewport = { width: 1440, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport, locale: 'ar' });
    const page = await context.newPage();
    // The catch-all is registered FIRST so the specific mocks below (Playwright runs the newest matching
    // handler first) win for Overpass / Nominatim. No request ever reaches the real internet.
    await page.route(url => !/^http:\/\/127\.0\.0\.1/.test(url.href) && !/^(data|blob):/.test(url.href), route => route.abort());
    await page.route(url => /overpass/i.test(url.href), async route => {
      overpass.requests++;
      if (overpass.mode === 'abort') return route.abort();
      if (overpass.delay) await new Promise(r => setTimeout(r, overpass.delay));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(MOCK_OVERPASS),
      });
    });
    await page.route(url => /nominatim/i.test(url.href), route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ display_name: 'غزة، فلسطين', lat: '31.5017', lon: '34.4668' }]),
    }));
    page.on('pageerror', err => pageErrors.push(String(err)));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/401|Unauthorized|Failed to load resource|ERR_FAILED/i.test(text)) return;
      consoleErrors.push(text);
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-screen:not([hidden])');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', 'test-password-123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#login-screen[hidden]', { state: 'attached' });
    return { context, page };
  }

  const state = page => page.evaluate(() => {
    const st = window.RelationshipMap._state;
    return {
      base: Boolean(st.base), v: st.base ? st.base.v : 0,
      vectorStatus: st.vectorStatus, vectorNote: st.vectorNote,
      areaBuiltin: Boolean(st.area && st.area.builtin), areaName: st.area && st.area.name, areaBbox: st.area && st.area.bbox,
      labelLang: st.labelLang, labelClasses: { ...st.labelClasses },
      labels: st.visibleLabels || 0,
      items: (st.visibleLabelItems || []).map(i => ({ n: i.n, k: i.k, r: i.r, lines: i.lines, box: i.box })),
      z: st.z, basemap: st.basemap, w: st.w, h: st.h,
    };
  });

  const openMap = async page => {
    await page.click('[data-view="map"]');
    await page.waitForSelector('.geo-frame', { state: 'visible' });
  };
  const setView = (page, lat, lng, z) => page.evaluate(([la, ln, zz]) => {
    const st = window.RelationshipMap._state;
    st.lat = la; st.lng = ln; st.z = zz; st.positioned = true;
    window.RelationshipMap.sync(true);
  }, [lat, lng, z]);
  const waitReady = (page, timeout = 25000) => page.waitForFunction(() => {
    const st = window.RelationshipMap && window.RelationshipMap._state;
    return st && st.base && st.vectorStatus === 'ready';
  }, { timeout });

  try {
    // =================================================================================================
    // Stage 1 — fresh install, bundled map, labels, language, toggles, hybrid, setup dialog, responsive
    // =================================================================================================
    let { context, page } = await openApp();
    await openMap(page);
    await waitReady(page);
    await page.waitForTimeout(400);

    // 3b: no dialog, no clicks, built-in area, bundled file used (Overpass never called).
    const fresh = await state(page);
    assert.equal(fresh.base, true, 'vector map installed automatically on a fresh profile');
    assert.equal(fresh.v, 2, 'installed map is the v2 format');
    assert.equal(fresh.areaBuiltin, true, 'the area is the fixed built-in Gaza area');
    assert.equal(fresh.areaName, 'منطقة غزة');
    assert.deepEqual(fresh.areaBbox, GAZA, 'built-in bounds match the offline tile pack');
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#geo-setup.open'))), false, 'no dialog was opened');
    assert.equal(overpass.requests, 0, 'the bundled file was used — Overpass was never called');

    // Labels of every class, ranked, no overlaps, inside the viewport.
    await page.evaluate(() => window.RelationshipMap._setBasemap('vector', false));
    await setView(page, 31.5, 34.44, 15.5);
    await page.waitForTimeout(400);
    const at15 = await state(page);
    assert.ok(at15.labels > 20, `expected many labels at zoom 15.5, got ${at15.labels}`);
    const classes = new Set(at15.items.map(i => i.k));
    for (const k of ['admin', 'hood', 'landmark']) assert.ok(classes.has(k), `class ${k} drawn (got ${[...classes].join(',')})`);
    for (let i = 0; i < at15.items.length; i++) {
      for (let j = i + 1; j < at15.items.length; j++) {
        const a = at15.items[i].box, b = at15.items[j].box;
        const overlap = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        assert.ok(!overlap, `labels "${at15.items[i].n}" and "${at15.items[j].n}" must not overlap`);
      }
    }
    assert.ok(
      at15.items.every(i => (i.box.left + i.box.right) / 2 > -40 && (i.box.left + i.box.right) / 2 < at15.w + 40),
      'labels are drawn near the visible area only',
    );

    // Documented zoom thresholds.
    await setView(page, 31.5, 34.44, 11);
    await page.waitForTimeout(300);
    const at11 = await state(page);
    assert.ok(at11.labels > 0, 'governorates/cities visible at low zoom');
    assert.ok(at11.items.every(i => i.r >= 5), 'only ranks 5-6 at zoom 11');
    await setView(page, 31.35, 34.3, 12.5);
    await page.waitForTimeout(300);
    assert.ok((await state(page)).items.some(i => i.k === 'city'), 'city labels at zoom 12.5');
    await setView(page, 31.5, 34.44, 13.5);
    await page.waitForTimeout(300);
    assert.ok((await state(page)).items.some(i => i.k === 'hood'), 'neighbourhoods/quarters at zoom 13.5');
    await setView(page, 31.5262, 34.4304, 16);
    await page.waitForTimeout(300);
    const port = await state(page);
    assert.ok(port.items.some(i => i.k === 'water'), 'water labels at zoom 16');
    assert.ok(port.items.some(i => i.k === 'landmark'), 'landmark labels at zoom 16');
    assert.ok(port.labels <= 250, 'at most ~250 labels per frame');

    await setView(page, 31.5, 34.44, 15.5);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'labels-vector-1440.png') });

    // 1B.2 name language
    await page.click('[data-g="layers"]');
    await page.waitForSelector('#geo-layers:not([hidden])');
    assert.equal(await page.isVisible('#geo-label-lang'), true, '«لغة الأسماء» selector lives in the layers popover');
    assert.deepEqual(await page.$$eval('#geo-label-lang [data-lang]', els => els.map(e => e.textContent.trim())), ['العربية', 'English', 'كلاهما']);
    const langResult = await page.evaluate(() => {
      const G = window.RelationshipGeo;
      const item = { n: 'غزة', ne: 'Gaza' };
      return { ar: G.labelLines(item, 'ar'), en: G.labelLines(item, 'en'), both: G.labelLines(item, 'both') };
    });
    assert.deepEqual(langResult.ar, ['غزة']);
    assert.deepEqual(langResult.en, ['Gaza']);
    assert.deepEqual(langResult.both, ['غزة', 'Gaza'], 'both -> two lines');
    await page.click('#geo-label-lang [data-lang="both"]');
    await page.waitForTimeout(350);
    assert.equal((await state(page)).labelLang, 'both');
    assert.ok((await state(page)).items.some(i => i.lines.length === 2), 'bilingual labels use two lines');

    // 1B.2 per-class toggles
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('[data-label-toggle]')].map(i => i.dataset.labelToggle)),
      ['admin', 'city', 'hood', 'landmark', 'parks'],
      'one toggle per class, parks+water combined',
    );
    const toggleLabels = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('[data-label-toggle]').forEach(i => { out[i.dataset.labelToggle] = i.closest('label').textContent.replace(/\s+/g, ' ').trim(); });
      return out;
    });
    assert.match(toggleLabels.admin, /المناطق الإدارية/);
    assert.match(toggleLabels.city, /المدن والبلدات/);
    assert.match(toggleLabels.hood, /الأحياء/);
    assert.match(toggleLabels.landmark, /المعالم والمرافق/);
    assert.match(toggleLabels.parks, /المتنزهات والمياه/);

    assert.ok((await state(page)).items.some(i => i.k === 'hood'), 'neighbourhood labels visible (vector basemap)');
    await page.click('[data-label-toggle="hood"]');
    await page.waitForTimeout(300);
    const hoodOff = await state(page);
    assert.equal(hoodOff.labelClasses.hood, false);
    assert.ok(!hoodOff.items.some(i => i.k === 'hood'), 'neighbourhood labels hidden by the toggle');
    await page.click('[data-label-toggle="landmark"]');
    await page.waitForTimeout(300);
    const landmarkOff = await state(page);
    assert.equal(landmarkOff.labelClasses.landmark, false);
    assert.ok(!landmarkOff.items.some(i => i.k === 'landmark'), 'landmarks hidden by the toggle');
    await page.click('[data-label-toggle="landmark"]');
    await page.waitForTimeout(350);
    assert.ok((await state(page)).items.some(i => i.k === 'landmark'), 'landmarks switched back on');
    await page.click('[data-label-toggle="parks"]');
    await page.waitForTimeout(300);
    const parksOff = await state(page);
    assert.equal(parksOff.labelClasses.green, false);
    assert.equal(parksOff.labelClasses.water, false);
    assert.ok(!parksOff.items.some(i => i.k === 'green' || i.k === 'water'), 'park and water labels both hidden');
    await page.click('[data-label-toggle="parks"]');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'layers-labels-1440.png') });
    await page.click('[data-g="layers"]');
    await page.waitForSelector('#geo-layers[hidden]', { state: 'attached' });

    // Settings persist across reload (same profile).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openMap(page);
    await waitReady(page);
    const persisted = await state(page);
    assert.equal(persisted.labelLang, 'both', 'name language persists');
    assert.equal(persisted.labelClasses.hood, false, 'per-class toggles persist');
    assert.equal(persisted.labelClasses.landmark, true);

    // 1B.2 hybrid: labels on top of the raster, hiding the classes the raster already shows.
    await setView(page, 31.5, 34.44, 15.5);
    await page.evaluate(() => window.RelationshipMap._setBasemap('hybrid', true));
    await page.waitForTimeout(900);
    const hybrid = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      return {
        basemap: st.basemap,
        isLight: document.querySelector('.geo-frame').classList.contains('is-light-map'),
        labels: st.visibleLabels || 0,
        classes: [...new Set((st.visibleLabelItems || []).map(i => i.k))],
        hideEnabled: st.hybridHideRasterClasses,
      };
    });
    assert.equal(hybrid.basemap, 'hybrid');
    assert.equal(hybrid.isLight, true, 'hybrid over the raster is a light background');
    assert.ok(hybrid.labels > 10, `labels drawn over the raster (got ${hybrid.labels})`);
    assert.equal(hybrid.hideEnabled, true, 'raster-shown classes hidden by default in hybrid');
    assert.ok(!hybrid.classes.includes('city'), 'city labels hidden over the raster (already on the tiles)');
    assert.ok(!hybrid.classes.includes('hood'), 'neighbourhood labels hidden over the raster');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'labels-hybrid-1440.png') });
    await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      st.hybridHideRasterClasses = false;
      st.labelClasses.hood = true;
      window.RelationshipMap.sync(true);
    });
    await page.waitForTimeout(400);
    assert.ok((await state(page)).items.some(i => i.k === 'hood'), 'neighbourhood labels can be shown over the raster');
    await page.evaluate(() => { window.RelationshipMap._state.hybridHideRasterClasses = true; });

    // Setup dialog: advanced, pre-filled with the built-in area.
    await page.evaluate(() => window.RelationshipMap._setBasemap('vector', true));
    await page.waitForTimeout(200);
    await page.click('[data-g="setup"]');
    await page.waitForSelector('#geo-setup.open');
    const setup = await page.evaluate(() => {
      const card = document.getElementById('gs-builtin');
      const custom = document.getElementById('gs-custom');
      return {
        builtinText: card ? card.textContent.replace(/\s+/g, ' ').trim() : '',
        reload: document.getElementById('gs-reload') ? document.getElementById('gs-reload').textContent.trim() : '',
        customOpen: custom ? custom.open : null,
        customSummary: custom ? custom.querySelector('summary').textContent.trim() : '',
      };
    });
    assert.match(setup.builtinText, /منطقة غزة/, 'built-in area name shown');
    assert.match(setup.builtinText, /المنطقة الافتراضية/);
    assert.match(setup.builtinText, /كم/);
    assert.equal(setup.reload, 'إعادة التحميل');
    assert.equal(setup.customOpen, false, 'custom area collapsed — not needed for normal use');
    assert.equal(setup.customSummary, 'منطقة مخصصة');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'setup-builtin-1440.png') });
    await page.evaluate(() => document.getElementById('geo-setup').classList.remove('open'));

    // Responsive screenshots with labels.
    for (const w of [1440, 700, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 780 : 900 });
      await setView(page, 31.5, 34.44, 14.5);
      await page.waitForTimeout(500);
      const st = await state(page);
      assert.ok(st.labels > 0, `labels drawn at ${w}px`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `labels-${w}px.png`) });
    }
    await context.close();

    // =================================================================================================
    // Stage 2 — a stored v1 map keeps working, the notice appears, replacement only after a success
    // =================================================================================================
    ({ context, page } = await openApp());
    await openMap(page);
    await waitReady(page);
    await page.evaluate(async v1 => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('relationship-map-geo', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v1, 'basemap');
        t.objectStore('kv').delete('vectormapHash');
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    }, v1Basemap());

    // The bundled file is temporarily missing and Overpass is unreachable: the v1 map must keep working.
    process.env.OFFLINE_VECTORMAP_FILE = path.join(tmpDir, 'no-such-vectormap.json');
    vectormapMod._reset();
    overpass.mode = 'abort';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openMap(page);
    await page.waitForFunction(() => {
      const st = window.RelationshipMap && window.RelationshipMap._state;
      return st && st.base && st.base.v === 1;
    }, { timeout: 20000 });
    await page.waitForTimeout(800);
    const v1State = await page.evaluate(() => ({
      v: window.RelationshipMap._state.base.v,
      noticeHidden: document.getElementById('geo-vecnote').hidden,
      buttonText: document.getElementById('geo-vec-update').textContent.trim(),
      showButton: !document.getElementById('geo-vec-update').hidden,
    }));
    assert.equal(v1State.v, 1, 'the old v1 map still works');
    assert.equal(v1State.noticeHidden, false, 'the update notice is shown');
    assert.equal(v1State.showButton, true);
    assert.equal(v1State.buttonText, 'تحديث الخريطة لعرض المزيد من الأسماء');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'v1-update-notice-1440.png') });

    await page.click('#geo-vec-update');
    await page.waitForTimeout(1500);
    const afterFail = await page.evaluate(() => ({
      v: window.RelationshipMap._state.base.v,
      showButton: !document.getElementById('geo-vec-update').hidden,
    }));
    assert.equal(afterFail.v, 1, 'the stored map is replaced only after a successful download');
    assert.equal(afterFail.showButton, true, 'the update button stays available to retry');

    // The bundled file is back: the update succeeds and replaces the v1 map.
    process.env.OFFLINE_VECTORMAP_FILE = VECTORMAP_PATH;
    vectormapMod._reset();
    await page.click('#geo-vec-update');
    await page.waitForFunction(() => {
      const st = window.RelationshipMap._state;
      return st.base && st.base.v === 2;
    }, { timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('geo-vecnote').hidden, { timeout: 10000 });
    const storedAfterUpdate = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('relationship-map-geo', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return await new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get('basemap');
        q.onsuccess = () => res(q.result && q.result.v); q.onerror = () => rej(q.error);
      });
    });
    assert.equal(storedAfterUpdate, 2, 'IndexedDB now holds the v2 map');
    await context.close();

    // =================================================================================================
    // Stage 3 — no bundled file, network on: background download with sub-request progress
    // =================================================================================================
    process.env.OFFLINE_VECTORMAP_FILE = path.join(tmpDir, 'no-such-vectormap.json');
    vectormapMod._reset();
    overpass.mode = 'mock';
    overpass.delay = 900;
    overpass.requests = 0;
    ({ context, page } = await openApp());
    await openMap(page);

    await page.waitForFunction(() => {
      const t = document.querySelector('#geo-vecnote [data-vec-text]');
      return /الجزء \d من \d/.test((t && t.textContent) || '');
    }, { timeout: 25000 });
    const during = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      return {
        chip: (document.querySelector('#geo-vecnote [data-vec-text]') || {}).textContent || '',
        chipHidden: document.getElementById('geo-vecnote').hidden,
        chipState: document.getElementById('geo-vecnote').dataset.state,
        status: st.vectorStatus,
        canvas: Boolean(document.getElementById('geo-canvas')),
        vectorButton: (document.querySelector('.geo-basemap-switch [data-basemap="vector"]') || {}).textContent || '',
      };
    });
    assert.match(during.chip, /الجزء \d من \d/, `progress chip shows the sub-request number (got "${during.chip}")`);
    assert.equal(during.chipHidden, false, 'the preparing chip is visible');
    assert.equal(during.chipState, 'busy');
    assert.equal(during.status, 'downloading');
    assert.equal(during.canvas, true, 'the canvas keeps working during the download');
    assert.match(during.vectorButton, /قيد التجهيز/, 'the vector button says «قيد التجهيز» while missing');

    // The app stays usable: panning works while the download runs.
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(560, 400, { steps: 6 });
    await page.mouse.up();

    await waitReady(page, 40000);
    await page.waitForFunction(() => document.getElementById('geo-vecnote').hidden, { timeout: 10000 });
    assert.ok(overpass.requests >= 4, `expected 4 sub-requests, got ${overpass.requests}`);
    assert.equal((await state(page)).v, 2, 'the map was downloaded in the background from Overpass');
    // The mocked elements are reused for every sub-request, so a merged map must not duplicate them.
    const merged = await page.evaluate(() => {
      const labels = window.RelationshipMap._state.base.labels;
      return { names: labels.map(l => l.n), classes: [...new Set(labels.map(l => l.k))], count: labels.length };
    });
    assert.equal(new Set(merged.names).size, merged.names.length, 'no duplicate labels after merging the sub-requests');
    assert.ok(merged.count >= 10, `merged labels (got ${merged.count})`);
    for (const k of ['admin', 'city', 'hood', 'landmark', 'green', 'water']) {
      assert.ok(merged.classes.includes(k), `class ${k} collected from the sub-requests`);
    }
    // And the drawing shows the labels that are due at this zoom.
    await setView(page, 31.5, 34.44, 15.5);
    await page.waitForTimeout(400);
    assert.ok((await state(page)).labels > 0, 'labels are drawn from the downloaded map');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'fallback-download-1440.png') });
    overpass.delay = 0;
    await context.close();

    // =================================================================================================
    // Stage 4 — no bundled file, offline: a clear Arabic message, the app keeps working
    // =================================================================================================
    overpass.mode = 'abort';
    ({ context, page } = await openApp());
    await openMap(page);
    await page.waitForFunction(() => {
      const st = window.RelationshipMap && window.RelationshipMap._state;
      return st && ['error', 'offline', 'missing-server'].includes(st.vectorStatus);
    }, { timeout: 25000 });
    const offlineState = await page.evaluate(() => ({
      status: window.RelationshipMap._state.vectorStatus,
      base: Boolean(window.RelationshipMap._state.base),
      basemap: window.RelationshipMap._state.basemap,
      canvas: Boolean(document.getElementById('geo-canvas')),
    }));
    assert.equal(offlineState.base, false, 'no street map could be downloaded');
    assert.equal(offlineState.basemap, 'raster', 'the offline raster map keeps the map usable');
    assert.equal(offlineState.canvas, true, 'the map view still works without a vector map');
    // Choosing the (missing) street map explains the situation instead of showing a blank screen.
    await page.evaluate(() => window.RelationshipMap._setBasemap('vector', true));
    await page.waitForTimeout(400);
    const noteState = await page.evaluate(() => ({
      hidden: document.getElementById('geo-zoomnote').hidden,
      text: document.getElementById('geo-zoomnote').textContent.replace(/\s+/g, ' ').trim(),
      button: document.querySelector('.geo-basemap-switch [data-basemap="vector"]').textContent.trim(),
    }));
    assert.equal(noteState.hidden, false, 'the zoom note explains that the street map is missing');
    assert.match(noteState.text, /خريطة الشوارع/);
    assert.doesNotMatch(noteState.text, /undefined/);
    assert.match(noteState.button, /قيد التجهيز/, 'the vector button stays marked «قيد التجهيز»');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'offline-fallback-1440.png') });
    await context.close();

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`);

    console.log('E2E Phase 1B passed. Screenshots:', fs.readdirSync(SCREENSHOT_DIR).sort().join(', '));
    return SCREENSHOT_DIR;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
