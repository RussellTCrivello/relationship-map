#!/usr/bin/env node
'use strict';
// Converts an MBTiles SQLite archive into a single read-only .tilepack file that the server can
// read at runtime with plain fs.read (no SQLite or native addons required at runtime).
//
// Binary layout (little-endian):
//   0..8    magic      "TILEPACK" (8 ASCII bytes)
//   8..12   version    uint32 = 1
//   12..16  metaBytes  uint32 byte length of UTF-8 JSON metadata
//   16..20  tileCount  uint32 number of indexed tiles
//   20..24  reserved   uint32 = 0
//   24..24+metaBytes   UTF-8 JSON: { name, format, minzoom, maxzoom, tileSize, bounds:{s,w,n,e}, attribution }
//   index              tileCount * 20 bytes: [z:u32, x:u32, y:u32 (XYZ), offset:u32, length:u32]
//   data               concatenated raw tile blobs (offsets are relative to the start of `data`)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAGIC = 'TILEPACK';
const VERSION = 1;
const HEADER_SIZE = 24;
const ENTRY_SIZE = 20;

const ROOT = path.join(__dirname, '..');
const DEFAULT_MBTILES = path.join(ROOT, 'offline_map', 'gaza_copernicus_osm_z11-z17.mbtiles');
const DEFAULT_OUT = path.join(ROOT, 'offline_map', 'gaza.tilepack');

function parseBounds(raw) {
  const parts = String(raw || '').split(',').map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { w: parts[0], s: parts[1], e: parts[2], n: parts[3] };
  }
  return { w: 34.208336, s: 31.199587, e: 34.581528, n: 31.610411 };
}

function normalizeMetadata(rawMeta = {}) {
  const bounds = rawMeta.bounds && typeof rawMeta.bounds === 'object'
    ? { s: Number(rawMeta.bounds.s), w: Number(rawMeta.bounds.w), n: Number(rawMeta.bounds.n), e: Number(rawMeta.bounds.e) }
    : parseBounds(rawMeta.bounds);
  return {
    name: String(rawMeta.name || 'Offline Raster Map').trim(),
    format: String(rawMeta.format || 'webp').trim().toLowerCase(),
    minzoom: Number.isFinite(Number(rawMeta.minzoom)) ? Number(rawMeta.minzoom) : 11,
    maxzoom: Number.isFinite(Number(rawMeta.maxzoom)) ? Number(rawMeta.maxzoom) : 17,
    tileSize: Number.isFinite(Number(rawMeta.tileSize || rawMeta.tile_size)) ? Number(rawMeta.tileSize || rawMeta.tile_size) : 256,
    bounds,
    attribution: String(rawMeta.attribution || '© OpenStreetMap contributors').trim(),
  };
}

// Writes a .tilepack file from normalized metadata and an array of tiles:
// [{ z, x, y (XYZ row) or tmsRow, data: Buffer }].
function writeTilepack(outPath, rawMeta, tiles) {
  const meta = normalizeMetadata(rawMeta);
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const sorted = tiles.map(t => {
    const z = Number(t.z);
    const x = Number(t.x);
    const y = t.y !== undefined ? Number(t.y) : ((1 << z) - 1 - Number(t.tmsRow));
    const data = Buffer.isBuffer(t.data) ? t.data : Buffer.from(t.data);
    return { z, x, y, data };
  }).sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);

  const header = Buffer.alloc(HEADER_SIZE);
  header.write(MAGIC, 0, 8, 'ascii');
  header.writeUInt32LE(VERSION, 8);
  header.writeUInt32LE(metaBuf.length, 12);
  header.writeUInt32LE(sorted.length, 16);
  header.writeUInt32LE(0, 20);

  const indexBuf = Buffer.alloc(sorted.length * ENTRY_SIZE);
  let dataOffset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const base = i * ENTRY_SIZE;
    indexBuf.writeUInt32LE(t.z, base);
    indexBuf.writeUInt32LE(t.x, base + 4);
    indexBuf.writeUInt32LE(t.y, base + 8);
    indexBuf.writeUInt32LE(dataOffset, base + 12);
    indexBuf.writeUInt32LE(t.data.length, base + 16);
    dataOffset += t.data.length;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, metaBuf);
    fs.writeSync(fd, indexBuf);
    for (const t of sorted) fs.writeSync(fd, t.data);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, outPath);
  return { outPath, outputPath: outPath, meta, tileCount: sorted.length, dataBytes: dataOffset };
}

function readVarint(buf, pos) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos + i];
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return { val: v, len: i + 1 };
  }
  const b = buf[pos + 8];
  v = v * 256 + b;
  return { val: v, len: 9 };
}

function serialTypeLen(st) {
  if (st === 0 || st === 8 || st === 9) return 0;
  if (st === 1) return 1;
  if (st === 2) return 2;
  if (st === 3) return 3;
  if (st === 4) return 4;
  if (st === 5) return 6;
  if (st === 6 || st === 7) return 8;
  if (st >= 12) return Math.floor((st - 12) / 2);
  return 0;
}

function readIntBE(buf, pos, len) {
  if (len === 1) return buf.readInt8(pos);
  if (len === 2) return buf.readInt16BE(pos);
  if (len === 3) {
    const u = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
    return (u & 0x800000) ? u - 0x1000000 : u;
  }
  if (len === 4) return buf.readInt32BE(pos);
  if (len === 6) return buf.readIntBE(pos, 6);
  if (len === 8) return Number(buf.readBigInt64BE(pos));
  return 0;
}

// Pure-JS SQLite3 B-tree reader for MBTiles (`metadata` and `tiles` tables).
// Works on Node 20+, Windows/macOS/Linux, and Electron without node:sqlite or Python.
function tryPureJsSqlite(mbtilesPath, outPath) {
  let fd = null;
  try {
    fd = fs.openSync(mbtilesPath, 'r');
    const hdr = Buffer.alloc(100);
    if (fs.readSync(fd, hdr, 0, 100, 0) !== 100 || hdr.toString('ascii', 0, 15) !== 'SQLite format 3') {
      return null;
    }
    let pageSize = hdr.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    const reserved = hdr[20];
    const U = pageSize - reserved;
    const maxLocal = U - 35;
    const minLocal = Math.floor((U - 12) * 32 / 255) - 23;

    const readPage = pgno => {
      const b = Buffer.allocUnsafe(pageSize);
      fs.readSync(fd, b, 0, pageSize, (pgno - 1) * pageSize);
      return b;
    };

    const readPayload = (pageBuf, cellOff, P) => {
      let localSize = P;
      if (P > maxLocal) {
        const K = minLocal + ((P - minLocal) % (U - 4));
        localSize = K <= maxLocal ? K : minLocal;
      }
      if (P === localSize) {
        return pageBuf.subarray(cellOff, cellOff + P);
      }
      const out = Buffer.allocUnsafe(P);
      pageBuf.copy(out, 0, cellOff, cellOff + localSize);
      let written = localSize;
      let ovfPg = pageBuf.readUInt32BE(cellOff + localSize);
      while (ovfPg !== 0 && written < P) {
        const op = readPage(ovfPg);
        ovfPg = op.readUInt32BE(0);
        const chunk = Math.min(P - written, U - 4);
        op.copy(out, written, 4, 4 + chunk);
        written += chunk;
      }
      return out;
    };

    const decodeRecord = payload => {
      const h = readVarint(payload, 0);
      const hdrEnd = h.val;
      let hPos = h.len;
      const types = [];
      while (hPos < hdrEnd) {
        const st = readVarint(payload, hPos);
        types.push(st.val);
        hPos += st.len;
      }
      let dPos = hdrEnd;
      const cols = [];
      for (const st of types) {
        if (st === 0) cols.push(null);
        else if (st === 8) cols.push(0);
        else if (st === 9) cols.push(1);
        else if (st >= 1 && st <= 6) {
          const len = serialTypeLen(st);
          cols.push(readIntBE(payload, dPos, len));
          dPos += len;
        } else if (st === 7) {
          cols.push(payload.readDoubleBE(dPos));
          dPos += 8;
        } else if (st >= 12 && st % 2 === 0) {
          const len = (st - 12) / 2;
          cols.push(Buffer.from(payload.subarray(dPos, dPos + len)));
          dPos += len;
        } else if (st >= 13 && st % 2 === 1) {
          const len = (st - 13) / 2;
          cols.push(payload.subarray(dPos, dPos + len).toString('utf8'));
          dPos += len;
        }
      }
      return cols;
    };

    const walkTable = (rootPg, onRow) => {
      const stack = [rootPg];
      while (stack.length) {
        const pgno = stack.pop();
        const page = readPage(pgno);
        const bhOff = pgno === 1 ? 100 : 0;
        const flag = page[bhOff];
        const cellCount = page.readUInt16BE(bhOff + 3);
        if (flag === 0x0d) {
          const ptrOff = bhOff + 8;
          for (let i = 0; i < cellCount; i++) {
            const cellPtr = page.readUInt16BE(ptrOff + i * 2);
            const pVar = readVarint(page, cellPtr);
            const rVar = readVarint(page, cellPtr + pVar.len);
            const recStart = cellPtr + pVar.len + rVar.len;
            const payload = readPayload(page, recStart, pVar.val);
            onRow(decodeRecord(payload));
          }
        } else if (flag === 0x05) {
          const rightChild = page.readUInt32BE(bhOff + 8);
          stack.push(rightChild);
          const ptrOff = bhOff + 12;
          for (let i = cellCount - 1; i >= 0; i--) {
            const cellPtr = page.readUInt16BE(ptrOff + i * 2);
            const leftChild = page.readUInt32BE(cellPtr);
            stack.push(leftChild);
          }
        } else {
          throw new Error('Unsupported B-tree page flag: ' + flag);
        }
      }
    };

    const tables = {};
    walkTable(1, row => {
      if (row[0] === 'table' && row[1] && Number.isInteger(row[3])) {
        tables[row[1]] = row[3];
      }
    });
    if (!tables.metadata || !tables.tiles) return null;

    const rawMeta = {};
    walkTable(tables.metadata, row => {
      if (row[0] != null) rawMeta[String(row[0])] = String(row[1] ?? '');
    });

    const tiles = [];
    walkTable(tables.tiles, row => {
      const z = Number(row[0]);
      const x = Number(row[1]);
      const tmsRow = Number(row[2]);
      const y = (1 << z) - 1 - tmsRow;
      const data = Buffer.isBuffer(row[3]) ? row[3] : Buffer.from(row[3] || []);
      tiles.push({ z, x, y, data });
    });

    return writeTilepack(outPath, rawMeta, tiles);
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_2) { /* ignore */ } }
  }
}

function tryNodeSqlite(mbtilesPath, outPath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { return null; }
  if (!DatabaseSync) return null;
  const db = new DatabaseSync(mbtilesPath, { open: true, readOnly: true });
  try {
    const rawMeta = {};
    for (const r of db.prepare('SELECT name, value FROM metadata').all()) {
      rawMeta[r.name] = r.value;
    }
    const rows = db.prepare('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY zoom_level, tile_column, tile_row').all();
    const tiles = rows.map(r => ({
      z: Number(r.zoom_level),
      x: Number(r.tile_column),
      y: (1 << Number(r.zoom_level)) - 1 - Number(r.tile_row),
      data: Buffer.from(r.tile_data),
    }));
    return writeTilepack(outPath, rawMeta, tiles);
  } finally {
    db.close();
  }
}

const PY_CONVERT = `
import sqlite3, json, struct, sys, os

mbtiles_path, out_path = sys.argv[1], sys.argv[2]
db = sqlite3.connect(mbtiles_path)
raw_meta = dict(db.execute('SELECT name, value FROM metadata').fetchall())
parts = [float(x) for x in str(raw_meta.get('bounds', '')).split(',') if x.strip()]
bounds = {'w': parts[0], 's': parts[1], 'e': parts[2], 'n': parts[3]} if len(parts) == 4 else {'w': 34.208336, 's': 31.199587, 'e': 34.581528, 'n': 31.610411}
meta = {
  'name': str(raw_meta.get('name', 'Offline Raster Map')).strip(),
  'format': str(raw_meta.get('format', 'webp')).strip().lower(),
  'minzoom': int(raw_meta.get('minzoom', 11)),
  'maxzoom': int(raw_meta.get('maxzoom', 17)),
  'tileSize': int(raw_meta.get('tileSize', raw_meta.get('tile_size', 256))),
  'bounds': bounds,
  'attribution': str(raw_meta.get('attribution', '© OpenStreetMap contributors')).strip(),
}
meta_bytes = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

rows = []
for z, x, tms_y, blob in db.execute('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles'):
  z = int(z); x = int(x); y = (1 << z) - 1 - int(tms_y)
  rows.append((z, x, y, bytes(blob)))
rows.sort(key=lambda r: (r[0], r[1], r[2]))

os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
tmp_path = f'{out_path}.tmp-{os.getpid()}'
with open(tmp_path, 'wb') as f:
  f.write(b'TILEPACK')
  f.write(struct.pack('<IIII', 1, len(meta_bytes), len(rows), 0))
  f.write(meta_bytes)
  offset = 0
  for z, x, y, blob in rows:
    f.write(struct.pack('<IIIII', z, x, y, offset, len(blob)))
    offset += len(blob)
  for _, _, _, blob in rows:
    f.write(blob)
os.replace(tmp_path, out_path)
print(json.dumps({'tileCount': len(rows), 'dataBytes': offset, 'meta': meta}))
`;

function tryPythonSqlite(mbtilesPath, outPath) {
  let lastErr;
  for (const bin of ['python3', 'python']) {
    try {
      const stdout = execFileSync(bin, ['-c', PY_CONVERT, mbtilesPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
      const info = JSON.parse(stdout.trim());
      return { outPath, meta: info.meta, tileCount: info.tileCount, dataBytes: info.dataBytes };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Could not convert MBTiles (neither node:sqlite nor python3 sqlite3 was available): ' + (lastErr && lastErr.message));
}

function buildTilepack(mbtilesPath = DEFAULT_MBTILES, outPath = DEFAULT_OUT) {
  if (!fs.existsSync(mbtilesPath)) {
    throw new Error(`MBTiles file not found: ${mbtilesPath}`);
  }
  return tryPureJsSqlite(mbtilesPath, outPath) || tryNodeSqlite(mbtilesPath, outPath) || tryPythonSqlite(mbtilesPath, outPath);
}

// Test helper: creates a synthetic .mbtiles SQLite database from metadata + tiles [{ z, x, y (XYZ) or tmsRow, data }].
function createMbtiles(mbtilesPath, rawMeta, tiles) {
  fs.mkdirSync(path.dirname(mbtilesPath), { recursive: true });
  if (fs.existsSync(mbtilesPath)) fs.unlinkSync(mbtilesPath);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { DatabaseSync = null; }
  if (DatabaseSync) {
    const db = new DatabaseSync(mbtilesPath);
    try {
      db.exec('CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row));');
      const insMeta = db.prepare('INSERT INTO metadata(name, value) VALUES(?, ?)');
      for (const [k, v] of Object.entries(rawMeta || {})) insMeta.run(String(k), String(v));
      const insTile = db.prepare('INSERT INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES(?, ?, ?, ?)');
      for (const t of tiles || []) {
        const z = Number(t.z), x = Number(t.x);
        const tmsRow = t.tmsRow !== undefined ? Number(t.tmsRow) : ((1 << z) - 1 - Number(t.y));
        insTile.run(z, x, tmsRow, Buffer.isBuffer(t.data) ? t.data : Buffer.from(t.data));
      }
      return mbtilesPath;
    } finally {
      db.close();
    }
  }
  const payload = JSON.stringify({
    meta: Object.fromEntries(Object.entries(rawMeta || {}).map(([k, v]) => [String(k), String(v)])),
    tiles: (tiles || []).map(t => {
      const z = Number(t.z), x = Number(t.x);
      const tmsRow = t.tmsRow !== undefined ? Number(t.tmsRow) : ((1 << z) - 1 - Number(t.y));
      const buf = Buffer.isBuffer(t.data) ? t.data : Buffer.from(t.data);
      return { z, x, tmsRow, b64: buf.toString('base64') };
    }),
  });
  const py = `
import sqlite3, json, base64, sys
path = sys.argv[1]
data = json.loads(sys.stdin.read())
db = sqlite3.connect(path)
db.execute('CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT)')
db.execute('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))')
for k, v in data['meta'].items():
  db.execute('INSERT INTO metadata(name, value) VALUES(?, ?)', (k, v))
for t in data['tiles']:
  db.execute('INSERT INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES(?, ?, ?, ?)', (t['z'], t['x'], t['tmsRow'], base64.b64decode(t['b64'])))
db.commit()
db.close()
`;
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['-c', py, mbtilesPath], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] });
      return mbtilesPath;
    } catch (_) { /* try next */ }
  }
  throw new Error('Could not create synthetic MBTiles');
}

module.exports = {
  MAGIC, VERSION, HEADER_SIZE, ENTRY_SIZE, DEFAULT_MBTILES, DEFAULT_OUT, DEFAULT_TILEPACK: DEFAULT_OUT,
  parseBounds, normalizeMetadata, writeTilepack, buildTilepack, createMbtiles, tryPureJsSqlite,
};

if (require.main === module) {
  const src = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MBTILES;
  const out = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUT;
  if (!fs.existsSync(src)) {
    console.warn(`Skipping tilepack build: ${src} not found.`);
    process.exit(0);
  }
  const res = buildTilepack(src, out);
  console.log(`Built tilepack: ${res.outPath} (${res.tileCount} tiles, ${(res.dataBytes / (1024 * 1024)).toFixed(1)} MB)`);
}
