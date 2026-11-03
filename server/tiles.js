'use strict';
// Serves pre-built offline raster map tiles from a single read-only .tilepack file.
// Only the header + compact index live in memory; tile blobs are read on demand with fs.read.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = 'TILEPACK';
const VERSION = 1;
const HEADER_SIZE = 24;
const ENTRY_SIZE = 20;
const ROOT = path.join(__dirname, '..');

let cached = null; // { filePath, mtimeMs, size, fd, meta, dataOffset, index: Map<string, {offset,length}>, stamp }

function closeCached() {
  if (cached && cached.fd !== null) {
    try { fs.closeSync(cached.fd); } catch (_) { /* ignore */ }
  }
  cached = null;
}

function resolvePackPath() {
  const envFile = process.env.OFFLINE_TILES_FILE;
  if (envFile !== undefined && String(envFile).trim() !== '') {
    return path.resolve(ROOT, String(envFile).trim());
  }
  if (process.resourcesPath) {
    const resPack = path.join(process.resourcesPath, 'offline_map', 'gaza.tilepack');
    if (fs.existsSync(resPack)) return resPack;
  }
  return path.join(ROOT, 'offline_map', 'gaza.tilepack');
}

function tryAutoBuildPack(filePath) {
  try {
    const dir = path.dirname(filePath);
    const mbtiles = path.join(dir, 'gaza_copernicus_osm_z11-z17.mbtiles');
    if (!fs.existsSync(mbtiles)) return false;
    const { buildTilepack } = require('../scripts/build-tilepack.js');
    buildTilepack(mbtiles, filePath);
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function loadPack() {
  const filePath = resolvePackPath();
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < HEADER_SIZE) { closeCached(); return null; }
  } catch (_) {
    if (tryAutoBuildPack(filePath)) {
      try {
        stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < HEADER_SIZE) { closeCached(); return null; }
      } catch (_2) {
        closeCached();
        return null;
      }
    } else {
      closeCached();
      return null;
    }
  }
  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  closeCached();
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(HEADER_SIZE);
    if (fs.readSync(fd, header, 0, HEADER_SIZE, 0) !== HEADER_SIZE) throw new Error('short header');
    if (header.toString('ascii', 0, 8) !== MAGIC) throw new Error('bad magic');
    const version = header.readUInt32LE(8);
    if (version !== VERSION) throw new Error('unsupported version');
    const metaBytes = header.readUInt32LE(12);
    const tileCount = header.readUInt32LE(16);
    const indexBytes = tileCount * ENTRY_SIZE;
    const dataOffset = HEADER_SIZE + metaBytes + indexBytes;
    if (metaBytes > 1024 * 1024 || dataOffset > stat.size) throw new Error('corrupt header');

    const metaBuf = Buffer.alloc(metaBytes);
    if (fs.readSync(fd, metaBuf, 0, metaBytes, HEADER_SIZE) !== metaBytes) throw new Error('short metadata');
    const meta = JSON.parse(metaBuf.toString('utf8'));

    const indexBuf = Buffer.alloc(indexBytes);
    if (fs.readSync(fd, indexBuf, 0, indexBytes, HEADER_SIZE + metaBytes) !== indexBytes) throw new Error('short index');
    const index = new Map();
    const rows = {};
    for (let i = 0; i < tileCount; i++) {
      const b = i * ENTRY_SIZE;
      const z = indexBuf.readUInt32LE(b);
      const x = indexBuf.readUInt32LE(b + 4);
      const y = indexBuf.readUInt32LE(b + 8);
      const offset = indexBuf.readUInt32LE(b + 12);
      const length = indexBuf.readUInt32LE(b + 16);
      if (dataOffset + offset + length <= stat.size) {
        index.set(`${z}/${x}/${y}`, { offset, length });
        const zr = rows[z] || (rows[z] = {});
        const yr = zr[y];
        if (!yr) zr[y] = [x, x];
        else { if (x < yr[0]) yr[0] = x; if (x > yr[1]) yr[1] = x; }
      }
    }
    const stamp = `${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}`;
    cached = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, fd, meta, dataOffset, index, rows, stamp };
    return cached;
  } catch (_) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_2) { /* ignore */ } }
    return null;
  }
}

function readSlice(fd, position, length) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(length);
    fs.read(fd, buf, 0, length, position, (err, bytesRead) => {
      if (err) reject(err);
      else if (bytesRead !== length) reject(new Error('unexpected EOF'));
      else resolve(buf);
    });
  });
}

function parseCoord(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,8}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

const router = express.Router();

router.get('/info', (req, res) => {
  const pack = loadPack();
  if (!pack) {
    return res.json({
      available: false,
      name: '',
      bounds: null,
      minzoom: 0,
      maxzoom: 0,
      tileSize: 256,
      attribution: '',
    });
  }
  const m = pack.meta || {};
  res.json({
    available: true,
    name: String(m.name || 'Offline Map'),
    bounds: m.bounds || null,
    minzoom: Number.isFinite(Number(m.minzoom)) ? Number(m.minzoom) : 11,
    maxzoom: Number.isFinite(Number(m.maxzoom)) ? Number(m.maxzoom) : 17,
    tileSize: Number.isFinite(Number(m.tileSize)) ? Number(m.tileSize) : 256,
    attribution: String(m.attribution || ''),
    rows: pack.rows || null,
  });
});

function handleTileRequest(req, res, next, zRaw, xRaw, yRaw) {
  const z = parseCoord(zRaw), x = parseCoord(xRaw), y = parseCoord(yRaw);
  if (z === null || x === null || y === null || z < 0 || z > 22) {
    return res.status(400).json({ error: 'invalid_tile_coords', message: 'إحداثيات البلاطة غير صالحة.' });
  }
  const maxCoord = 2 ** z;
  if (x < 0 || x >= maxCoord || y < 0 || y >= maxCoord) {
    return res.status(400).json({ error: 'invalid_tile_coords', message: 'إحداثيات البلاطة خارج النطاق.' });
  }
  const pack = loadPack();
  if (!pack) return res.status(404).end();
  const entry = pack.index.get(`${z}/${x}/${y}`);
  if (!entry) return res.status(404).end();

  const etag = `"t-${pack.stamp}-${z}-${x}-${y}-${entry.offset.toString(36)}-${entry.length.toString(36)}"`;
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const inm = String(req.headers['if-none-match'] || '');
  if (inm && (inm === '*' || inm.split(',').map(s => s.trim()).includes(etag))) {
    return res.status(304).end();
  }

  readSlice(pack.fd, pack.dataOffset + entry.offset, entry.length)
    .then(buf => res.end(buf))
    .catch(next);
}

router.get('/:z/:x/:file', (req, res, next) => {
  const m = /^([^.]+)\.webp$/.exec(String(req.params.file || ''));
  if (!m) return res.status(400).json({ error: 'invalid_tile_coords', message: 'صيغة طلب البلاطة غير صالحة.' });
  return handleTileRequest(req, res, next, req.params.z, req.params.x, m[1]);
});

// Catch-all for malformed paths under /api/tiles (e.g., traversal attempts that didn't match 3 segments)
router.use((req, res) => {
  res.status(400).json({ error: 'invalid_tile_coords', message: 'مسار البلاطة غير صالح.' });
});

module.exports = { router, resolvePackPath, loadPack, _reset: closeCached };
