const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/app.css'), 'utf8');

test('selected nodes and relations show no browser focus box', () => {
  assert.match(css, /#network-svg :focus[^{]*\{outline:none!important\}|#graph :focus[^{]*\{outline:none!important\}/);
});

test('Delete removes the selected entity or relation through a styled confirmation', () => {
  assert.match(app, /function confirmDialog\(/);
  const del = app.slice(app.indexOf('async function deleteEntity'), app.indexOf('function edgeFields'));
  assert.doesNotMatch(del, /(^|[^\w])confirm\(/);
  assert.match(app, /async function deleteEntity/);
  assert.match(app, /async function deleteEdge/);
  assert.match(app, /key==='delete'\|\|key==='backspace'/);
  assert.match(css, /\.confirm-card\{/);
  assert.match(html, /<kbd>Del<\/kbd>/);
});

test('details panel shows the current location and the event sequence', () => {
  assert.match(app, /function placeCard\(/);
  assert.match(app, /\$\{placeCard\(n,rels\)\}\$\{miniGraph/);
  assert.match(app, /RelationshipEvents\.entityPanel\(id\)/); // the event sequence is now the "الأحداث" tab
  assert.match(app, /name:'location'/);
  assert.match(app, /name:'date'/);
  assert.match(css, /\.timeline\{/);
});

test('overview map has a header with zoom, fit and collapse, and fits the whole graph', () => {
  for (const id of ['minimap-zoom', 'minimap-fit', 'minimap-toggle', 'minimap-count']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function minimapBounds\(/);
  assert.match(css, /\.minimap-wrap\.collapsed/);
});
