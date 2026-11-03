// Starts the relationship-map server inside the desktop app, with single-file storage.
// Kept free of Electron imports so it can be tested with plain Node.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
const randomPassword = (n = 12) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

function listen(app, host, firstPort, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = port => {
      const server = app.listen(port, host);
      server.once('listening', () => resolve({ server, port: server.address().port }));
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && port < firstPort + tries) attempt(port + 1);
        else reject(err);
      });
    };
    attempt(firstPort);
  });
}

// appDir: folder that contains server/, src/, assets/, data/ and index.html.
async function startBackend({ appDir, dataFile, tilesFile, vectorMapFile, port = 47831, host = '127.0.0.1', strictPort = false }) {
  process.env.DB_ENGINE = 'file';
  process.env.DATA_FILE = dataFile;
  process.env.NODE_ENV = 'production';
  if (tilesFile) {
    process.env.OFFLINE_TILES_FILE = tilesFile;
  } else if (!process.env.OFFLINE_TILES_FILE) {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'offline_map', 'gaza.tilepack') : null,
      path.join(appDir, 'offline_map', 'gaza.tilepack'),
      path.join(appDir, '..', 'offline_map', 'gaza.tilepack'),
      path.join(appDir, '..', '..', 'offline_map', 'gaza.tilepack'),
    ].filter(Boolean);
    const found = candidates.find(p => fs.existsSync(p));
    if (found) process.env.OFFLINE_TILES_FILE = found;
  }
  if (vectorMapFile) {
    process.env.OFFLINE_VECTORMAP_FILE = vectorMapFile;
  } else if (!process.env.OFFLINE_VECTORMAP_FILE) {
    const vecCandidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'offline_map', 'gaza.vectormap.json') : null,
      path.join(appDir, 'offline_map', 'gaza.vectormap.json'),
      path.join(appDir, '..', 'offline_map', 'gaza.vectormap.json'),
      path.join(appDir, '..', '..', 'offline_map', 'gaza.vectormap.json'),
    ].filter(Boolean);
    const foundVec = vecCandidates.find(p => fs.existsSync(p));
    if (foundVec) process.env.OFFLINE_VECTORMAP_FILE = foundVec;
  }
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });

  // The very first start creates the administrator with a random password that the app shows once.
  const firstRun = !fs.existsSync(dataFile) && !fs.existsSync(`${dataFile}.bak`);
  let initialPassword = null;
  if (firstRun && !process.env.ADMIN_PASSWORD) {
    initialPassword = randomPassword();
    process.env.ADMIN_PASSWORD = initialPassword;
  }

  const { app } = require(path.join(appDir, 'server/app.js'));
  const auth = require(path.join(appDir, 'server/auth.js'));
  const { pool } = require(path.join(appDir, 'server/db.js'));
  const admin = await auth.getAdmin();
  const { server, port: boundPort } = await listen(app, host, port, strictPort ? 0 : 20);

  return {
    url: `http://${host}:${boundPort}/`,
    port: boundPort,
    username: admin.username,
    initialPassword,
    // For a forgotten password: sets a new random one and signs every session out.
    async resetPassword() {
      const next = randomPassword();
      await pool.query('UPDATE admin_account SET password_hash=$1, updated_at=now() WHERE id=1', [await auth.hashPassword(next)]);
      await pool.query('DELETE FROM admin_sessions');
      return next;
    },
    stop: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

module.exports = { startBackend, randomPassword };
