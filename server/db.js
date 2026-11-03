// DB_ENGINE=file selects the single-file storage used by the desktop app (see file-pool.js).
// Anything else uses PostgreSQL, which needs DATABASE_URL.
if (process.env.DB_ENGINE === 'file') {
  module.exports = require('./file-pool');
} else {
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, application_name: 'relationship-map' });
  module.exports = { pool };
}
