'use strict';
// Serves the bundled offline vector basemap (offline_map/gaza.vectormap.json) with ETag, SHA-256 version hash and gzip.
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const G = require('../src/geo.js');

const ROOT = path.join(__dirname, '..');

let cached = null; // { filePath, mtimeMs, size, rawBuf, gzipBuf, hash, etag, info }

function resetCached() {
  cached = null;
}

function resolveVectorMapPath() {
  const envFile = process.env.OFFLINE_VECTORMAP_FILE;
  if (envFile !== undefined && String(envFile).trim() !== '') {
    return path.resolve(ROOT, String(envFile).trim());
  }
  if (process.resourcesPath) {
    const resFile = path.join(process.resourcesPath, 'offline_map', 'gaza.vectormap.json');
    if (fs.existsSync(resFile)) return resFile;
  }
  return path.join(ROOT, 'offline_map', 'gaza.vectormap.json');
}

function loadVectorMap() {
  const filePath = resolveVectorMapPath();
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) {
      cached = null;
      return null;
    }
  } catch (_) {
    cached = null;
    return null;
  }

  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  try {
    const rawBuf = fs.readFileSync(filePath);
    const parsed = JSON.parse(rawBuf.toString('utf8'));
    G.validateBasemap(parsed);
    const gzipBuf = zlib.gzipSync(rawBuf);
    const hash = crypto.createHash('sha256').update(rawBuf).digest('hex').slice(0, 16);
    const etag = `"vm-${hash}"`;
    const info = {
      v: parsed.v || 1,
      bbox: parsed.bbox || G.GAZA_BOUNDS,
      created: parsed.created || '',
      detail: parsed.detail || 'medium',
      stats: G.basemapStats(parsed),
    };
    cached = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: rawBuf.length,
      rawBuf,
      gzipBuf,
      hash,
      etag,
      info,
    };
    return cached;
  } catch (_) {
    cached = null;
    return null;
  }
}

const router = express.Router();

router.get('/info', (req, res) => {
  const entry = loadVectorMap();
  if (!entry) {
    return res.json({
      available: false,
      version: 0,
      hash: '',
      size: 0,
      gzipSize: 0,
      bbox: G.GAZA_BOUNDS,
    });
  }
  res.json({
    available: true,
    version: entry.info.v,
    hash: entry.hash,
    size: entry.size,
    gzipSize: entry.gzipBuf.length,
    bbox: entry.info.bbox,
    created: entry.info.created,
    stats: entry.info.stats,
  });
});

router.get('/', (req, res) => {
  const entry = loadVectorMap();
  if (!entry) {
    return res.status(404).json({
      error: 'vectormap_not_found',
      message: 'ملف خريطة الشوارع غير موجود على الخادم.',
    });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('ETag', entry.etag);
  res.setHeader('X-Vectormap-Hash', entry.hash);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Vary', 'Accept-Encoding');

  const inm = String(req.headers['if-none-match'] || '');
  if (inm && (inm === '*' || inm.split(',').map(s => s.trim()).includes(entry.etag))) {
    return res.status(304).end();
  }

  const acceptEnc = String(req.headers['accept-encoding'] || '');
  if (/\bgzip\b/i.test(acceptEnc)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(entry.gzipBuf.length));
    return res.end(entry.gzipBuf);
  }

  res.setHeader('Content-Length', String(entry.rawBuf.length));
  return res.end(entry.rawBuf);
});

module.exports = { router, resolveVectorMapPath, loadVectorMap, _reset: resetCached };
