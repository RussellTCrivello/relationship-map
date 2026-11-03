// Copies the web app (server, front end, data, migrations) into desktop/app so electron-builder can pack it.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ['server', 'src', 'assets', 'data', 'db', 'index.html']) {
  fs.cpSync(path.join(root, item), path.join(out, item), { recursive: true });
}
const { buildTilepack, DEFAULT_MBTILES, DEFAULT_TILEPACK } = require('../../scripts/build-tilepack.js');
if (!fs.existsSync(DEFAULT_TILEPACK) && fs.existsSync(DEFAULT_MBTILES)) {
  const res = buildTilepack(DEFAULT_MBTILES, DEFAULT_TILEPACK);
  console.log(`Built offline tilepack: ${res.tileCount} tiles -> ${res.outputPath}`);
}
const { DEFAULT_VECTORMAP } = require('../../scripts/build-vector-map.js');
if (fs.existsSync(DEFAULT_VECTORMAP)) {
  console.log('Bundled offline vector map ready:', DEFAULT_VECTORMAP);
}
console.log('App files copied to', out);
require('./make-icon').makeIcon(path.join(__dirname, '..', 'build', 'icon.png'));
