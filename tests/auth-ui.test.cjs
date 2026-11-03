const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');

test('login screen and account menu are wired (login only when the server provides it)', () => {
  for (const id of ['login-screen', 'login-form', 'login-user', 'login-pass', 'login-error', 'account-btn']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /await ensureLoggedIn\(\)/);
  assert.match(app, /function openAccount\(/);
  assert.match(app, /code==='unauthorized'/, 'an expired session asks for a new login instead of losing edits');
});
