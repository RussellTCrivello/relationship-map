require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('./db');

// Applies every db/migrations/*.sql file once, in name order. Each file runs in its own
// transaction and is recorded in schema_migrations, so re-running is safe.
async function migrate() {
  const dir = path.join(__dirname, '../db/migrations');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    // 001 creates schema_migrations itself; make sure it exists before we read it.
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [version]);
        await client.query('COMMIT');
        console.log(`Applied migration ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed: ${err.message}`);
      }
    }
    console.log('Database migrations up to date.');
  } finally {
    client.release();
  }
}

migrate()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
