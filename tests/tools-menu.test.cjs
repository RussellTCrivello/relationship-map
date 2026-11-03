const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '..', 'src/app.js'), 'utf8');

test('tools menu closes on any outside click and on Escape', () => {
  assert.match(app, /document\.addEventListener\('pointerdown'.*advanced-tools/s);
  assert.match(app, /e\.key==='Escape'&&d\?\.open/);
});
