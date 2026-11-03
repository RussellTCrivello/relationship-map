'use strict';
// End-to-end Playwright test for Phase 1: Offline raster map, base-map switcher, and working area recognition.
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

const ROOT = path.resolve(__dirname, '..');
const PACK_PATH = path.join(ROOT, 'offline_map', 'gaza.tilepack');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/phase1-screenshots';

const MOCK_OVERPASS = {
  elements: [
    {
      type: 'way',
      id: 100,
      tags: { highway: 'trunk', name: 'شارع صلاح الدين' },
      geometry: [
        { lat: 31.26, lon: 34.27 },
        { lat: 31.35, lon: 34.32 },
        { lat: 31.42, lon: 34.37 },
        { lat: 31.50, lon: 34.46 },
        { lat: 31.55, lon: 34.51 },
      ],
    },
    {
      type: 'way',
      id: 101,
      tags: { highway: 'primary', name: 'شارع الرشيد الساحلي' },
      geometry: [
        { lat: 31.30, lon: 34.24 },
        { lat: 31.40, lon: 34.32 },
        { lat: 31.46, lon: 34.37 },
        { lat: 31.52, lon: 34.43 },
        { lat: 31.56, lon: 34.47 },
      ],
    },
    {
      type: 'way',
      id: 102,
      tags: { highway: 'primary', name: 'شارع عمر المختار' },
      geometry: [
        { lat: 31.501, lon: 34.435 },
        { lat: 31.515, lon: 34.455 },
        { lat: 31.524, lon: 34.468 },
      ],
    },
    {
      type: 'way',
      id: 103,
      tags: { highway: 'secondary', name: 'شارع الجلاء' },
      geometry: [
        { lat: 31.505, lon: 34.450 },
        { lat: 31.535, lon: 34.452 },
      ],
    },
    {
      type: 'way',
      id: 104,
      tags: { waterway: 'river', name: 'وادي غزة' },
      geometry: [
        { lat: 31.465, lon: 34.374 },
        { lat: 31.448, lon: 34.415 },
        { lat: 31.430, lon: 34.450 },
      ],
    },
    { type: 'node', id: 201, lat: 31.516, lon: 34.458, tags: { place: 'city', name: 'غزة' } },
    { type: 'node', id: 202, lat: 31.535, lon: 34.483, tags: { place: 'town', name: 'جباليا' } },
    { type: 'node', id: 203, lat: 31.448, lon: 34.392, tags: { place: 'town', name: 'النصيرات' } },
    { type: 'node', id: 204, lat: 31.418, lon: 34.351, tags: { place: 'city', name: 'دير البلح' } },
    { type: 'node', id: 205, lat: 31.346, lon: 34.303, tags: { place: 'city', name: 'خان يونس' } },
    { type: 'node', id: 206, lat: 31.287, lon: 34.251, tags: { place: 'city', name: 'رفح' } },
  ],
};

async function run() {
  assert.ok(fs.existsSync(PACK_PATH), `Expected tilepack at ${PACK_PATH} (run npm run prepare-app first)`);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-e2e-phase1-'));
  process.env.DB_ENGINE = 'file';
  process.env.DATA_FILE = path.join(tmpDir, 'db.json');
  process.env.OFFLINE_TILES_FILE = PACK_PATH;
  // Phase 1 tests the offline raster map WITHOUT the vector map (Request 1B installs it automatically),
  // so the bundled vector file is deliberately missing here and Overpass stays blocked until we ask for it.
  process.env.OFFLINE_VECTORMAP_FILE = path.join(tmpDir, 'no-vectormap.json');
  require('../server/vectormap.js')._reset();
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password-123';
  tilesMod._reset();

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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ar',
  });

  const page = await context.newPage();

  // Mock external Overpass & Nominatim calls so the test never touches the internet.
  // Overpass answers only once `allowOverpass` is set, so the map starts with no vector data.
  let allowOverpass = false;
  await page.route(url => /overpass/i.test(url.href), async route => {
    if (!allowOverpass) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(MOCK_OVERPASS),
    });
  });
  await page.route(url => /nominatim/i.test(url.href), async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([
        { display_name: 'غزة، فلسطين', lat: '31.5017', lon: '34.4668', boundingbox: ['31.199587', '31.610411', '34.208336', '34.581528'] },
      ]),
    });
  });

  const pageErrors = [];
  const consoleErrors = [];
  let preLogin401Count = 0;

  page.on('pageerror', err => { console.error('PAGEERROR:', err); pageErrors.push(String(err)); });
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const txt = msg.text();
    if (/401|Unauthorized/i.test(txt) && preLogin401Count < 1) {
      preLogin401Count++;
      return;
    }
    // Deliberate network failures: the app starts without a vector map / without the tile pack.
    if (/Failed to load resource|ERR_FAILED|net::ERR/i.test(txt)) return;
    consoleErrors.push(txt);
  });

  try {
    // 1. Open app and sign in
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-screen:not([hidden])');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', 'test-password-123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('#login-screen[hidden]', { state: 'attached' });

    // 2. Switch to Geographic Map view
    await page.click('[data-view="map"]');
    await page.waitForSelector('.geo-frame', { state: 'visible' });

    // Wait for /api/tiles/info and initial raster tiles to load & draw
    await page.waitForFunction(() => {
      const st = window.RelationshipMap && window.RelationshipMap._state;
      return st && st.tileInfo && st.tileInfo.available === true && st.basemap === 'raster' && st.area && st.area.name === 'منطقة غزة';
    });
    await page.waitForTimeout(500);

    // Verify default basemap is 'raster' («الخريطة المحمّلة») and built-in area is shown
    const initialCheck = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      const activeBtn = document.querySelector('[data-basemap][aria-pressed="true"]');
      const areaTxt = document.getElementById('geo-area-txt').textContent;
      const attrib = document.getElementById('geo-attrib').textContent;
      const isLight = document.querySelector('.geo-frame').classList.contains('is-light-map');
      // Sample canvas pixels around the center to confirm raster tiles rendered
      const canvas = document.getElementById('geo-canvas');
      const ctx = canvas.getContext('2d');
      const midX = Math.floor(canvas.width / 2);
      const midY = Math.floor(canvas.height / 2);
      const px = ctx.getImageData(midX, midY, 1, 1).data;
      return {
        basemap: st.basemap,
        activeMode: activeBtn && activeBtn.dataset.basemap,
        areaTxt,
        attrib,
        isLight,
        centerPixel: [px[0], px[1], px[2], px[3]],
      };
    });

    assert.equal(initialCheck.basemap, 'raster', 'Default basemap should be raster when pack is available and no vector map is saved');
    assert.equal(initialCheck.activeMode, 'raster');
    assert.match(initialCheck.areaTxt, /منطقة غزة.*كم²/);
    assert.match(initialCheck.attrib, /OpenStreetMap contributors.*Eurostat GISCO/);
    assert.equal(initialCheck.isLight, true);
    assert.ok(
      initialCheck.centerPixel[0] > 40 || initialCheck.centerPixel[1] > 40 || initialCheck.centerPixel[2] > 40,
      `Expected light raster tile pixels on canvas, got rgba(${initialCheck.centerPixel.join(',')})`
    );

    // 3. Add a geographic entity inside Gaza and one outside Gaza, then select the inside entity
    await page.evaluate(() => {
      const H = window.RelationshipHost;
      const G = window.RelationshipGeo;
      const nodes = H.state.nodes;
      if (nodes[0]) {
        G.applyGeo(nodes[0], {
          lat: 31.515,
          lng: 34.455,
          place: 'مجمع الشفاء الطبي',
          address: 'حي الرمال، غزة',
          note: 'نقطة داخل حدود منطقة غزة',
        });
      }
      if (nodes[1]) {
        G.applyGeo(nodes[1], {
          lat: 31.66,
          lng: 34.62,
          place: 'موقع خارج الحدود',
          address: 'شمال شرق القطاع',
          note: 'نقطة خارج حدود الحزمة تبقى ظاهرة',
        });
      }
      H.refreshAfterMutation('تحديد مواقع تجريبية', nodes[0].id, { keepView: true });
      window.RelationshipMap.showOnMap(nodes[0].id);
    });
    await page.waitForTimeout(700);

    // Verify pin and card are visible and have high-contrast styling on light raster map
    const pinAndContrast = await page.evaluate(() => {
      const pinHead = document.querySelector('.geo-pin.selected .geo-pin-head');
      const hudSpan = document.querySelector('.geo-hud > span');
      const attribEl = document.getElementById('geo-attrib');
      const cardEl = document.getElementById('geo-card');
      const pinBoxShadow = pinHead ? getComputedStyle(pinHead).boxShadow : '';
      const hudBg = hudSpan ? getComputedStyle(hudSpan).backgroundColor : '';
      const hudColor = hudSpan ? getComputedStyle(hudSpan).color : '';
      const attribBg = attribEl ? getComputedStyle(attribEl).backgroundColor : '';
      return {
        cardVisible: cardEl && !cardEl.hidden,
        pinCount: document.querySelectorAll('.geo-pin, .geo-cluster').length,
        pinBoxShadow,
        hudBg,
        hudColor,
        attribBg,
      };
    });
    assert.equal(pinAndContrast.cardVisible, true, 'Selected pin card should be open');
    assert.ok(pinAndContrast.pinCount >= 1, 'Pins should be rendered');
    assert.match(pinAndContrast.pinBoxShadow, /rgb/, 'Selected pin on light raster map has high-contrast ring shadow');

    // 4. Test switching between raster, hybrid, and vector while preserving view, selection, and open card
    const beforeSwitch = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      return { lat: st.lat, lng: st.lng, z: st.z, selected: st.selected, cardHidden: document.getElementById('geo-card').hidden };
    });

    // Click 'hybrid' («مدمجة»)
    await page.click('.geo-basemap-switch [data-basemap="hybrid"]');
    const afterHybrid = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      const sliderWrap = document.getElementById('geo-hybrid-wrap');
      const attrib = document.getElementById('geo-attrib').textContent;
      return {
        basemap: st.basemap,
        lat: st.lat,
        lng: st.lng,
        z: st.z,
        selected: st.selected,
        cardHidden: document.getElementById('geo-card').hidden,
        sliderVisible: sliderWrap && !sliderWrap.hidden,
        attrib,
      };
    });
    assert.equal(afterHybrid.basemap, 'hybrid');
    assert.equal(afterHybrid.lat, beforeSwitch.lat);
    assert.equal(afterHybrid.lng, beforeSwitch.lng);
    assert.equal(afterHybrid.z, beforeSwitch.z);
    assert.equal(afterHybrid.selected, beforeSwitch.selected);
    assert.equal(afterHybrid.cardHidden, false, 'Open card must remain open across basemap switches');
    assert.equal(afterHybrid.sliderVisible, true, 'Hybrid opacity slider must appear in hybrid mode');
    assert.match(afterHybrid.attrib, /مساهمو OpenStreetMap.*Eurostat GISCO/, 'Hybrid mode attribution includes both sources');

    // Click 'vector' («خريطة الشوارع») before vector data is downloaded -> verify helpful note is shown
    await page.click('.geo-basemap-switch [data-basemap="vector"]');
    const vectorBeforeDownload = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      const note = document.getElementById('geo-zoomnote');
      const attrib = document.getElementById('geo-attrib').textContent;
      return {
        basemap: st.basemap,
        noteVisible: note && !note.hidden,
        noteText: note ? note.textContent : '',
        attrib,
      };
    });
    assert.equal(vectorBeforeDownload.basemap, 'vector');
    assert.equal(vectorBeforeDownload.noteVisible, true, 'When vector map has not been downloaded, zoomnote explains and offers download');
    assert.match(vectorBeforeDownload.attrib, /مساهمو OpenStreetMap/);

    // Download the vector basemap (built-in area) via the setup dialog with the mocked Overpass, so we can
    // verify the full vector & hybrid rendering.
    allowOverpass = true;
    await page.click('[data-geo-open-setup]');
    await page.waitForSelector('#geo-setup.open', { timeout: 5000 });
    await page.click('#gs-reload');
    await page.waitForFunction(() => Boolean(window.RelationshipMap._state.base), { timeout: 5000 });
    await page.evaluate(() => {
      document.getElementById('geo-setup')?.classList.remove('open');
      const st = window.RelationshipMap._state;
      st.lat = 31.512;
      st.lng = 34.442;
      st.z = 14;
      window.RelationshipMap.sync(true);
    });

    // Capture vector screenshot at 1440px
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'basemap-vector-1440.png') });

    // Press keyboard shortcut 'b' on canvas to cycle: vector -> raster -> hybrid
    await page.focus('#geo-canvas');
    await page.keyboard.press('b');
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.basemap), 'raster', 'B key cycles vector -> raster');
    await page.waitForTimeout(550);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'basemap-raster-1440.png') });

    await page.keyboard.press('b');
    assert.equal(await page.evaluate(() => window.RelationshipMap._state.basemap), 'hybrid', 'B key cycles raster -> hybrid');
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'basemap-hybrid-1440.png') });

    // Verify layers popover mirrors basemap choice, opacity slider, and outside-area dimming toggle
    await page.click('[data-g="layers"]');
    await page.waitForSelector('#geo-layers:not([hidden])');
    const layersCheck = await page.evaluate(() => {
      const dimInput = document.querySelector('#geo-layers input[data-layer="dimOutside"]');
      const areaInput = document.querySelector('#geo-layers input[data-layer="area"]');
      const rangeInput = document.getElementById('geo-layers-hybrid-alpha');
      return {
        hasDimToggle: Boolean(dimInput && dimInput.checked),
        hasAreaToggle: Boolean(areaInput && areaInput.checked),
        rangeVal: rangeInput ? Number(rangeInput.value) : null,
      };
    });
    assert.equal(layersCheck.hasDimToggle, true);
    assert.equal(layersCheck.hasAreaToggle, true);
    assert.equal(layersCheck.rangeVal, 75);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'layers-popover-1440.png') });
    await page.click('[data-g="layers"]');

    // 5. Working area recognition: pan far outside Gaza and verify outside-area hint + «العودة إلى المنطقة» button
    await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      st.lat = 33.5;
      st.lng = 36.3;
      st.z = 12;
      window.RelationshipMap.sync();
    });
    await page.waitForTimeout(250);
    const outsideVisible = await page.evaluate(() => !document.getElementById('geo-outside-hint').hidden);
    assert.equal(outsideVisible, true, 'Outside-area hint should appear when panned away from Gaza');

    // Click «العودة إلى المنطقة» inside the hint and wait for flyTo
    await page.click('#geo-outside-hint [data-g="area"]');
    await page.waitForTimeout(650);
    const afterReturn = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      return {
        outsideHidden: document.getElementById('geo-outside-hint').hidden,
        inGazaLat: st.lat > 31.19 && st.lat < 31.62,
        inGazaLng: st.lng > 34.20 && st.lng < 34.59,
      };
    });
    assert.equal(afterReturn.outsideHidden, true);
    assert.equal(afterReturn.inGazaLat, true);
    assert.equal(afterReturn.inGazaLng, true);

    // 6. Persistence across reload + offline verification (context.setOffline(true))
    await page.click('.geo-basemap-switch [data-basemap="raster"]');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.geo-frame', { state: 'visible' });
    await page.waitForFunction(() => window.RelationshipMap && window.RelationshipMap._state.tileInfo?.available);
    await page.waitForTimeout(500); // let visible tiles finish loading into LRU cache
    const persistedMode = await page.evaluate(() => window.RelationshipMap._state.basemap);
    assert.equal(persistedMode, 'raster', 'Selected basemap persists across page reload');

    // Enable Playwright offline mode and verify the map continues to operate and switch modes without errors
    await context.setOffline(true);
    await page.focus('#geo-canvas');
    await page.keyboard.press('b'); // -> hybrid
    await page.keyboard.press('b'); // -> vector
    await page.keyboard.press('b'); // -> raster
    await page.waitForTimeout(200);
    await context.setOffline(false);

    // 7. Capture responsive screenshots at 1440px, 1100px, 700px, and 390px
    for (const [w, h] of [[1440, 900], [1100, 820], [700, 860], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => window.RelationshipMap.sync());
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `responsive-${w}px.png`) });
    }

    // 8. Verify graceful behavior when the tilepack file is missing (available: false)
    await page.setViewportSize({ width: 1440, height: 900 });
    process.env.OFFLINE_TILES_FILE = path.join(tmpDir, 'nonexistent.tilepack');
    tilesMod._reset();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.geo-frame', { state: 'visible' });
    await page.waitForFunction(() => {
      const st = window.RelationshipMap && window.RelationshipMap._state;
      return st && st.tileInfo && st.tileInfo.available === false;
    });
    const missingPackState = await page.evaluate(() => {
      const st = window.RelationshipMap._state;
      const rasterBtn = document.querySelector('.geo-basemap-switch [data-basemap="raster"]');
      const hybridBtn = document.querySelector('.geo-basemap-switch [data-basemap="hybrid"]');
      return {
        basemap: st.basemap,
        rasterDisabled: rasterBtn ? rasterBtn.disabled : false,
        hybridDisabled: hybridBtn ? hybridBtn.disabled : false,
        rasterTitle: rasterBtn ? rasterBtn.getAttribute('title') : '',
      };
    });
    assert.equal(missingPackState.basemap, 'vector', 'Falls back to vector when pack is missing');
    assert.equal(missingPackState.rasterDisabled, true, 'Raster button is disabled when pack is missing');
    assert.equal(missingPackState.hybridDisabled, true, 'Hybrid button is disabled when pack is missing');
    assert.equal(missingPackState.rasterTitle, 'ملف الخريطة غير موجود على هذا الجهاز');

    // Assert zero unexpected page/console errors
    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`);

    console.log('E2E Phase 1 passed all checks! Screenshots saved to:', SCREENSHOT_DIR);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
