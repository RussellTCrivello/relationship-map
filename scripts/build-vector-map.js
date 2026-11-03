#!/usr/bin/env node
'use strict';
// Builds offline_map/gaza.vectormap.json (v2 format) for the built-in Gaza working area
// by splitting the bounding box into sub-requests, querying Overpass with retry across mirrors,
// merging with de-duplication by OSM id, and running parseOverpass (detail: "medium").

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const G = require('../src/geo.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VECTORMAP = path.join(ROOT, 'offline_map', 'gaza.vectormap.json');

const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function readBoundsFromTilepack() {
  try {
    const { loadPack } = require('../server/tiles.js');
    const pack = loadPack();
    if (pack && pack.meta && pack.meta.bounds && G.validLatLng(pack.meta.bounds.s, pack.meta.bounds.w)) {
      return pack.meta.bounds;
    }
  } catch (_) { /* ignore */ }
  return { ...G.GAZA_BOUNDS };
}

async function fetchSubBox(subBox, detail = 'medium', endpoints = OVERPASS_ENDPOINTS, timeoutMs = 150000) {
  const query = G.overpassQuery(subBox, { detail, timeout: 120 });
  let lastErr = null;
  for (const url of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'RelationshipMap/2.0 (https://gitlab.com/aae-group/relationship-map)',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timeout|too many/i.test(json.remark) && !(json.elements || []).length) {
        throw new Error(`${url} -> ${json.remark}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

async function buildVectorMap(opts = {}) {
  const outputPath = path.resolve(opts.outputPath || DEFAULT_VECTORMAP);
  const force = Boolean(opts.force);
  if (!force && fs.existsSync(outputPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      G.validateBasemap(raw);
      if (raw.v === 2) {
        const rawBytes = fs.statSync(outputPath).size;
        return { outputPath, skipped: true, stats: G.basemapStats(raw), rawBytes };
      }
    } catch (_) { /* rebuild */ }
  }

  const bounds = opts.bounds || readBoundsFromTilepack();
  const detail = opts.detail || 'medium';
  const parts = G.splitBbox(bounds, { grid: opts.grid });
  const responses = [];

  for (const part of parts) {
    const msg = `الجزء ${part.index} من ${part.total}`;
    if (typeof opts.onProgress === 'function') opts.onProgress(msg, part);
    else console.log(`[build-vector-map] Downloading ${msg} (${part.s},${part.w} -> ${part.n},${part.e})...`);
    const json = await fetchSubBox(part, detail, opts.endpoints || OVERPASS_ENDPOINTS);
    responses.push(json);
  }

  const merged = G.mergeOverpass(responses);
  const bm = G.parseOverpass(merged, bounds, { detail, clipBbox: true });
  G.validateBasemap(bm);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const serialized = JSON.stringify(bm);
  const tmpPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  fs.renameSync(tmpPath, outputPath);

  const gz = zlib.gzipSync(Buffer.from(serialized, 'utf8'));
  const stats = G.basemapStats(bm);
  return {
    outputPath,
    skipped: false,
    stats,
    rawBytes: Buffer.byteLength(serialized, 'utf8'),
    gzipBytes: gz.length,
  };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  buildVectorMap({ force })
    .then(res => {
      if (res.skipped) {
        console.log(`Using existing v2 vector map: ${res.outputPath} (${(res.rawBytes / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        console.log(`Built ${res.outputPath}:`);
        console.log(`  Raw size : ${(res.rawBytes / (1024 * 1024)).toFixed(2)} MB (${res.rawBytes.toLocaleString('en-US')} bytes)`);
        console.log(`  Gzip size: ${(res.gzipBytes / (1024 * 1024)).toFixed(2)} MB (${res.gzipBytes.toLocaleString('en-US')} bytes)`);
        console.log(`  Stats    :`, res.stats);
      }
    })
    .catch(err => {
      console.error('Failed to build vector map:', err.message);
      process.exit(1);
    });
}

module.exports = { buildVectorMap, DEFAULT_VECTORMAP, OVERPASS_ENDPOINTS };
