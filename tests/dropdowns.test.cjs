const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/app.css'), 'utf8');

test('selects and search suggestions use styled lists instead of native popups', () => {
  assert.match(app, /function styledSelects\(/);
  assert.match(app, /className='dd-list'/);
  assert.match(app, /function searchSuggestKey\(/);
  assert.doesNotMatch(html, /<datalist|list="search-suggestions"/);
  assert.match(html, /id="search-suggest"/);
  assert.match(css, /\.dd-list\{/);
  assert.match(css, /\.suggest-item/);
});

test('fonts are bundled locally (no internet) and selectable from the tools menu', () => {
  assert.doesNotMatch(html + css, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(css, /--font:'Zain'/);
  assert.match(css, /:root\[data-font="plex"\]/);
  for (const f of ['Zain-Regular', 'Zain-Bold', 'IBMPlexSansArabic-Regular', 'IBMPlexSansArabic-Bold']) {
    assert.ok(fs.existsSync(path.join(root, 'assets/fonts', f + '.woff')), f);
    assert.match(css, new RegExp(`fonts/${f}\\.woff`));
  }
  assert.match(html, /id="font-select"/);
  assert.match(app, /function fontChoice\(/);
});

test('clicking the map hides the details panel only while the option is on', () => {
  const m = app.match(/function dismissUI\(\)\{.*?\n  \}/s);
  assert.ok(m, 'dismissUI exists');
  assert.match(m[0], /if\(!uiPrefs\.hidePanel\)return/);
  assert.match(m[0], /panel-collapsed/);
  assert.match(html, /id="hide-panel-switch"/);
});
