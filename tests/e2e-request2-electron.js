'use strict';
// Real Electron restart with the same persistent profile and loopback origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.join(__dirname, '..');
async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-electron-profile-'));
  const binary = process.env.ELECTRON_BINARY || require(require.resolve('electron', { paths: [path.join(root, 'desktop')] }));
  const env = { ...process.env, NODE_OPTIONS: '', XDG_CONFIG_HOME: path.join(tmp, 'config'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password-123', ELECTRON_DISABLE_SANDBOX: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    const app = await electron.launch({ executablePath: binary, args: ['--no-sandbox', path.join(root, 'desktop/main.js')], env, timeout: 45000 });
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(userData.startsWith(tmp), `profile must be isolated: ${userData}`);
    const page = await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:47831/**');
    const login = await page.request.post('http://127.0.0.1:47831/api/auth/login', { data: { username: 'admin', password: 'test-password-123' } }); assert.ok(login.ok());
    await page.goto('http://127.0.0.1:47831/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.RelationshipMap?._state?.areaStorageReady && window.RelationshipMap?._state?.base && window.RelationshipHost?.state?.nodes?.length);
    return { app, page, userData };
  };
  let current;
  try {
    current = await launch();
    const userData = current.userData;
    await current.page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.fetch = (url, opts) => /overpass/i.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : native(url, opts);
      window.RelationshipMap._setView('map');
    });
    await current.page.click('[data-g="setup"]'); await current.page.locator('#gs-custom summary').click();
    await current.page.fill('#gs-name', 'منطقة سطح المكتب'); await current.page.fill('#gs-lat', '40'); await current.page.fill('#gs-lng', '-74'); await current.page.fill('#gs-side', '10');
    await current.page.click('#gs-go');
    await current.page.waitForFunction(() => window.RelationshipMap._state.area?.name === 'منطقة سطح المكتب' && window.RelationshipMap._state.base);
    const savedId = await current.page.evaluate(() => window.RelationshipMap._state.activeAreaId);
    await current.app.close(); current = null;
    current = await launch(); assert.equal(current.userData, userData);
    assert.equal(await current.page.evaluate(() => window.RelationshipMap._state.activeAreaId), savedId);
    assert.equal(await current.page.evaluate(() => window.RelationshipMap._state.area.name), 'منطقة سطح المكتب');
    assert.equal(await current.page.evaluate(() => window.RelationshipMap._state.base.bbox.s > 39), true);
    await current.page.evaluate(() => window.RelationshipMap._setView('map'));
    await current.page.click('[data-g="setup"]');
    await current.page.context().setOffline(true);
    assert.equal(await current.page.evaluate(() => navigator.onLine), false);
    await current.page.selectOption('#gs-areas', 'gaza'); await current.page.click('#gs-switch');
    await current.page.waitForFunction(() => window.RelationshipMap._state.area.id === 'gaza' && window.RelationshipMap._state.base);
    await current.page.selectOption('#gs-areas', savedId); await current.page.click('#gs-switch');
    await current.page.waitForFunction(id => window.RelationshipMap._state.area.id === id && window.RelationshipMap._state.base, savedId);
    await current.page.context().setOffline(false);
    console.log('Request 2 Electron persistent-profile restart and offline area switching passed');
  } finally { if (current) await current.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
