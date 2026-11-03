'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDataset } = require('../src/data-validation');
const data = zones => ({ nodes: [{ id: 1, label: 'أحمد' }], edges: [], ...(zones === undefined ? {} : { zones }) });
const polygon = { id: 'z1', name: 'المنطقة', color: '#d4ff3f', shape: 'polygon', points: [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 0, lng: 1 }], photos: [] };
test('zone validation accepts old datasets and each supported geometry', () => {
  assert.doesNotThrow(() => validateDataset(data()));
  assert.doesNotThrow(() => validateDataset(data([polygon, { ...polygon, id: 'z2', shape: 'rectangle', points: polygon.points.slice(0, 2) }, { id: 'z3', name: 'دائرة', color: '#aabbcc', shape: 'circle', center: { lat: 31, lng: 34 }, radius: 10 }])));
});
test('zone validation rejects duplicates, malformed geometry and unsafe photos', () => {
  assert.throws(() => validateDataset(data([polygon, polygon])), /مكرر/);
  assert.throws(() => validateDataset(data([{ ...polygon, points: [{ lat: 900, lng: 0 }, ...polygon.points] }])), /نقاط/);
  assert.throws(() => validateDataset(data([{ ...polygon, color: 'red' }])), /لون/);
  assert.throws(() => validateDataset(data([{ ...polygon, photos: [{ src: 'javascript:alert(1)' }] }])), /صور/);
  assert.throws(() => validateDataset(data([{ ...polygon, photos: Array.from({ length: 13 }, () => ({ src: 'https://example.com/x' })) }])), /صور/);
  assert.throws(() => validateDataset(data([{ ...polygon, shape: 'circle', center: { lat: 0, lng: 0 }, radius: -1 }])), /دائرة/);
});
