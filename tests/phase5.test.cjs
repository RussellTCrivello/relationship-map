const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateDataset } = require('../src/data-validation.js');
const { saveWithBackup } = require('../src/data-persistence.js');
const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/network.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/app.css'), 'utf8');

test('starter network is non-empty and validates', () => {
  assert.ok(data.nodes.length > 0, 'starter data has entities');
  assert.ok(data.edges.length > 0, 'starter data has relationships');
  assert.equal(validateDataset(data), data);
});

test('network identifiers are unique and all edge endpoints exist', () => {
  assert.equal(new Set(data.nodes.map(n => String(n.id))).size, data.nodes.length);
  assert.equal(new Set(data.edges.map(e => String(e.id))).size, data.edges.length);
  const ids = new Set(data.nodes.map(n => String(n.id)));
  for (const edge of data.edges) {
    assert.ok(ids.has(String(edge.source)), `missing source for edge ${edge.id}`);
    assert.ok(ids.has(String(edge.target)), `missing target for edge ${edge.id}`);
    assert.notEqual(String(edge.source), String(edge.target));
  }
});

test('validator rejects duplicate node IDs, duplicate edge IDs and dangling links', () => {
  assert.throws(() => validateDataset({ nodes: [{id: 1, label: 'A'}, {id: '1', label: 'B'}], edges: [] }), /مكرر/);
  assert.throws(() => validateDataset({ nodes: [{id: 1, label: 'A'}, {id: 2, label: 'B'}], edges: [{id: 1, source: 1, target: 2}, {id: '1', source: 2, target: 1}] }), /مكرر/);
  assert.throws(() => validateDataset({ nodes: [{id: 1, label: 'A'}], edges: [{id: 1, source: 1, target: 99}] }), /كيان غير موجود/);
  assert.throws(() => validateDataset({ nodes: [{id: 1, label: 'A'}], edges: [{id: 1, source: 1, target: 1}] }), /بنفسه/);
});

test('primary controls remain unique and backup recovery is wired', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
  for (const id of ['add-node-btn', 'add-edge-btn', 'export-json-btn', 'export-png-btn', 'import-json-btn', 'restore-backup-btn', 'advanced-tools', 'storage-state']) assert.ok(ids.includes(id), `missing #${id}`);
  assert.match(html, /src="src\/data-validation\.js"/);
  assert.match(html, /src="src\/data-persistence\.js"/);
  assert.match(html, /src="src\/api-client\.js"/);
  assert.ok(html.indexOf('src/api-client.js') < html.indexOf('src/app.js'), 'api-client must load before app.js');
  assert.match(app, /STORAGE_BACKUP_KEY/);
  assert.match(app, /beforeunload/);
  assert.match(app, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(app, /RelationshipDataPersistence.saveWithBackup/);
});


test('saving creates a recoverable previous version and verifies the new payload', () => {
  const store = new Map([['dataset', '{"version":1}']]);
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k,v) => store.set(k,String(v)) };
  const result = saveWithBackup(storage, 'dataset', 'backup', '{"version":2}', '{"version":0}');
  assert.equal(store.get('dataset'), '{"version":2}');
  assert.equal(store.get('backup'), '{"version":1}');
  assert.equal(result.backupSaved, true);
  assert.equal(result.hadPrevious, true);
});

test('a failed primary write leaves the previous dataset in backup', () => {
  const store = new Map([['dataset', '{"safe":true}']]);
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k,v) => { if(k==='dataset') throw new Error('quota'); store.set(k,String(v)); } };
  assert.throws(() => saveWithBackup(storage, 'dataset', 'backup', '{"safe":false}'), /quota/);
  assert.equal(store.get('dataset'), '{"safe":true}');
  assert.equal(store.get('backup'), '{"safe":true}');
});

test('accessibility and responsive preferences are present', () => {
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /skip-link/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width:430px/);
});


test('scene UI is removed and automatic layout persistence is available', () => {
  assert.doesNotMatch(html, /autosave-layout-switch|collapse-group-btn|backup-now-btn/, 'redundant tools were removed');
  assert.doesNotMatch(html, /saved-view-select|save-view-btn|apply-view-btn|delete-view-btn/);
  assert.match(app, /AUTO_LAYOUT_KEY/);
  assert.match(app, /restoreAutoLayoutState/);
  assert.match(app, /saveAutoLayoutState/);
});

test('keyboard shortcuts handle history and selected-node actions', () => {
  assert.match(app, /key==='z'\|\|key==='y'/);
  assert.match(app, /key==='z'&&e\.shiftKey/);
  assert.match(app, /key==='e'&&state\.selected/);
  assert.match(app, /key==='r'&&state\.selected/);
});

test('entity source links are limited to http(s) URLs', () => {
  assert.match(app, /n\.url&&\/\^https\?:/);
});

test('context actions are positioned beside the relationship count badge', () => {
  assert.match(app, /radius\*\.7\+10/);
  assert.match(app, /علاقة`/);
  assert.match(css, /node-context-toolbar/);
});

test('drag-to-link: node action button can be dragged onto another node', () => {
  assert.match(app, /function createLink\(/);
  assert.match(app, /\[data-node-action="edge"\]/);
  assert.match(app, /state\.linking/);
  assert.match(app, /cancelLink\('أُلغي الربط'\)/, 'Esc cancels an in-progress link');
  assert.match(app, /keepView:true/, 'linking must not re-zoom the map');
  assert.match(css, /\.link-preview/);
  assert.match(css, /\.node\.link-target/);
  assert.match(css, /\.node-context-toolbar button\{touch-action:none\}/);
});

test('overview map can be dragged, wheel-zoomed and keyboard-panned', () => {
  assert.match(app, /function visibleGraphRect\(/);
  assert.match(app, /function centerViewOn\(/);
  assert.match(app, /canvas\.addEventListener\('pointermove'/);
  assert.match(app, /canvas\.addEventListener\('wheel'/);
  assert.match(css, /#minimap\.is-dragging/);
  assert.doesNotMatch(app, /\$\('#minimap'\)\.addEventListener\('click'/, 'the click-only handler was replaced by pointer dragging');
});

test('while a link is dragged no entity is dimmed', () => {
  assert.match(app, /const linkingNow=/);
  assert.match(app, /relationDim=!linkingNow&&/);
  assert.match(app, /is-linking'\);applyFilters\(\)/, 'dimming is recomputed when the drag starts');
});

test('details panel is organised into tabs with relationship cards and swap direction', () => {
  assert.match(app, /role="tablist"/);
  assert.match(app, /data-tab="relations"/);
  assert.match(app, /function swapEdge\(/);
  assert.match(app, /id="swap-edge-btn"/);
  assert.match(app, /function miniGraph\(/);
  assert.match(css, /\.meter\b/);
});

test('data values are shown in Arabic (edge types, countries, attribute keys)', () => {
  assert.match(app, /const EDGE_TYPE_AR=|const EDGE_TYPE_AR =/);
  assert.match(app, /function typeAr\(/);
  assert.match(app, /function countryAr\(/);
  assert.match(app, /\['النوع',edge\.type\?typeAr\(edge\.type\)/);
});

test('tools menu: grouped sections, extra exports, import preview, click-away dismiss', () => {
  for (const id of ['export-nodes-csv-btn', 'export-edges-csv-btn', 'export-png-btn', 'undo-btn', 'redo-btn']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function exportCsv\(/);
  assert.match(app, /function exportPng\(/);
  assert.match(app, /name="import-mode"/);
  assert.match(app, /function dismissUI\(/);
  assert.match(app, /if\(cleanMapClick\)dismissUI\(\)/);
});

test('Esc closes tool dialogs and statuses are shown in Arabic', () => {
  assert.match(app, /editor-modal\.open:not\(#editor-modal\)/, 'Esc closes the path/compare/audit dialogs');
  assert.match(app, /function statusLabel/);
  assert.doesNotMatch(app, /esc\(n\.status\|\|'—'\)/, 'node status must go through statusLabel');
});

test('map labels are decluttered so they do not overlap', () => {
  assert.match(app, /function layoutLabels\(/);
  assert.match(app, /function scheduleLabelLayout\(/);
  assert.match(app, /setAttribute\('display','none'\)/, 'overlapping labels are hidden, not moved');
});

test('map arrangement is also saved to the database when connected', () => {
  assert.match(app, /scheduleDbLayoutSave/);
  assert.match(app, /api\.loadLayout\(\)/);
  assert.match(app, /restoreAutoLayoutState\(dbLayout\)/);
});
