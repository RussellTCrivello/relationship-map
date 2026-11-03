// Draws the app icon (a small relationship graph on a dark rounded square) and writes it as a PNG,
// so no binary file has to be kept in the repository.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512, SS = 3; // output size and supersampling factor
const lime = [205, 254, 100], bg = [14, 18, 25];
const nodes = [
  { x: .5, y: .29, r: .055, c: [120, 200, 255] },
  { x: .29, y: .63, r: .055, c: [255, 120, 120] },
  { x: .71, y: .63, r: .055, c: [160, 140, 255] },
  { x: .5, y: .51, r: .068, c: lime },
];
const links = [[0, 3], [1, 3], [2, 3], [0, 1], [0, 2], [1, 2]];

const inRoundRect = (x, y, m, rad) => {
  const lo = m, hi = 1 - m;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = x < lo + rad ? lo + rad : x > hi - rad ? hi - rad : x;
  const cy = y < lo + rad ? lo + rad : y > hi - rad ? hi - rad : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
};
const distToSegment = (px, py, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
};

// Colour (r,g,b,a 0..1) of one sub-pixel at normalised coordinates.
function sample(x, y) {
  if (!inRoundRect(x, y, .04, .2)) return [0, 0, 0, 0];
  if (!inRoundRect(x, y, .052, .19)) return [...lime, 1];
  for (const n of nodes) if (Math.hypot(x - n.x, y - n.y) <= n.r) return [...n.c, 1];
  for (const [i, j] of links) if (distToSegment(x, y, nodes[i], nodes[j]) <= .01) return [...lime, .7];
  return [...bg, 1];
}

function render() {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let py = 0; py < SIZE; py++) {
    raw[py * (SIZE * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + .5) / SS) / SIZE, (py + (sy + .5) / SS) / SIZE);
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
      }
      const n = SS * SS, o = py * (SIZE * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  return raw;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function makeIcon(file) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(render(), { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return file;
}

module.exports = { makeIcon };
if (require.main === module) console.log('Icon written to', makeIcon(path.join(__dirname, '..', 'build', 'icon.png')));
