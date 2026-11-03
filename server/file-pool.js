// File-backed storage with the same interface as the PostgreSQL pool (query / connect / end).
//
// Used by the desktop app (DB_ENGINE=file) so no database server is needed: everything lives in one
// JSON file (DATA_FILE) that is replaced atomically on every commit, and the previous version is
// kept next to it as <file>.bak. It understands only the statements server/app.js and
// server/auth.js issue. An unknown statement throws, so a change to those files that adds new SQL
// fails loudly in the tests instead of silently doing nothing.
const fs = require('node:fs');
const path = require('node:path');

const SESSION_RE = /^INSERT INTO admin_sessions\(token_hash,expires_at\) VALUES\(\$1, now\(\) \+ \(\$2 \|\| ' milliseconds'\)::interval\)$/;

const emptyState = () => ({
  meta: { revision: 0, last_request_id: null, zones: [] },
  entities: [],
  relationships: [],
  layout: null,
  admin: null,
  sessions: [],
});

let file = null;
let state = null;
let snapshot = null; // state at BEGIN, restored on ROLLBACK
let dirty = false; // the open transaction changed something
let recoveredFromBackup = false;

function dataFile() {
  if (!file) {
    file = process.env.DATA_FILE;
    if (!file) throw new Error('DATA_FILE is required when DB_ENGINE=file.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return file;
}

function load() {
  if (state) return state;
  const f = dataFile();
  let invalid = false;
  for (const candidate of [f, `${f}.bak`]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships) || !parsed.meta || typeof parsed.meta !== 'object') throw new Error('invalid file');
      state = { ...emptyState(), ...parsed };
      if (candidate !== f) { recoveredFromBackup = true; console.warn('تم استرجاع البيانات من النسخة الاحتياطية الأخيرة.'); }
      return state;
    } catch (e) {
      if (e.code !== 'ENOENT') { invalid = true; console.warn('تعذرت قراءة ملف البيانات؛ ستُجرَّب النسخة الاحتياطية إن وُجدت.'); }
    }
  }
  if (invalid) throw new Error('ملف البيانات والنسخة الاحتياطية غير صالحين؛ لم يُستبدل أي ملف.');
  state = emptyState();
  return state;
}

function persist() {
  const f = dataFile();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  if (!recoveredFromBackup) { try { fs.copyFileSync(f, `${f}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  fs.renameSync(tmp, f);
  recoveredFromBackup = false;
}

const norm = sql => String(sql).replace(/\s+/g, ' ').trim();
const result = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
const parseJson = v => (typeof v === 'string' ? JSON.parse(v) : v);

// Executes one statement against the in-memory state. Returns { rows, rowCount }.
function run(rawSql, params = []) {
  const s = load();
  const sql = norm(rawSql);

  if (/^BEGIN\b/i.test(sql)) { snapshot = /READ ONLY/i.test(sql) ? s : structuredClone(s); dirty = false; return result(); }
  if (/^COMMIT$/i.test(sql)) { const write = snapshot !== null && dirty; snapshot = null; dirty = false; if (write) persist(); return result(); }
  if (/^ROLLBACK$/i.test(sql)) { if (snapshot) { state = snapshot; snapshot = null; } dirty = false; return result(); }
  const autocommit = snapshot === null;
  const done = (r, changed) => { if (changed) { if (autocommit) persist(); else dirty = true; } return r; };

  if (sql === 'SELECT 1') return result([{ '?column?': 1 }]);

  if (/^SELECT revision(,last_request_id)? FROM graph_meta WHERE id=1( FOR UPDATE)?$/.test(sql)) {
    return result([{ revision: s.meta.revision, last_request_id: s.meta.last_request_id }]);
  }
  if (sql === 'SELECT zones FROM graph_meta WHERE id=1') return result([{ zones: s.meta.zones || [] }]);
  if (sql === 'UPDATE graph_meta SET zones=$1::jsonb WHERE id=1') { s.meta.zones = parseJson(params[0]); return done(result([], 1), true); }
  if (sql === 'UPDATE graph_meta SET revision=revision+1,last_request_id=$1,updated_at=now() WHERE id=1 RETURNING revision') {
    s.meta.revision += 1; s.meta.last_request_id = params[0] ?? null;
    return done(result([{ revision: s.meta.revision }]), true);
  }
  if (sql === 'UPDATE graph_meta SET revision=0, last_request_id=NULL WHERE id=1') {
    s.meta = { revision: 0, last_request_id: null, zones: [] };
    return done(result(), true);
  }

  if (sql === 'SELECT id,attributes FROM entities WHERE deleted_at IS NULL ORDER BY seq') {
    return result(s.entities.map(e => ({ id: e.id, attributes: e.attributes })));
  }
  if (sql === 'SELECT id,source_entity_id,target_entity_id,attributes FROM relationships WHERE deleted_at IS NULL ORDER BY seq') {
    return result(s.relationships.map(r => ({ id: r.id, source_entity_id: r.source, target_entity_id: r.target, attributes: r.attributes })));
  }
  if (sql === 'SELECT id FROM entities WHERE deleted_at IS NULL') return result(s.entities.map(e => ({ id: e.id })));
  if (sql === 'SELECT id,attributes FROM entities WHERE id=$1 AND deleted_at IS NULL') {
    const e = s.entities.find(x => x.id === String(params[0]));
    return result(e ? [{ id: e.id, attributes: e.attributes }] : []);
  }

  if (sql === 'DELETE FROM relationships') { const n = s.relationships.length; s.relationships = []; return done(result([], n), true); }
  if (sql === 'DELETE FROM entities') { const n = s.entities.length; s.entities = []; s.relationships = []; return done(result([], n), true); }
  if (/^TRUNCATE entities, relationships CASCADE$/.test(sql)) { s.entities = []; s.relationships = []; return done(result(), true); }

  if (/^INSERT INTO entities\(id,name,type,attributes\) SELECT id,name,type,attributes FROM unnest\(/.test(sql)) {
    const [ids, names, types, attrs] = params;
    ids.forEach((id, i) => s.entities.push({ id, name: names[i], type: types[i], attributes: parseJson(attrs[i]) }));
    return done(result([], ids.length), true);
  }
  if (/^INSERT INTO relationships\(id,source_entity_id,target_entity_id,type,attributes\) SELECT id,source,target,type,attributes FROM unnest\(/.test(sql)) {
    const [ids, sources, targets, types, attrs] = params;
    const known = new Set(s.entities.map(e => e.id));
    ids.forEach((id, i) => {
      if (!known.has(sources[i]) || !known.has(targets[i])) throw new Error('insert or update on table "relationships" violates foreign key constraint');
      s.relationships.push({ id, source: sources[i], target: targets[i], type: types[i], attributes: parseJson(attrs[i]) });
    });
    return done(result([], ids.length), true);
  }

  if (sql === 'SELECT layout,positions,view,updated_at FROM layout_state WHERE id=1') {
    return result(s.layout ? [s.layout] : []);
  }
  if (/^INSERT INTO layout_state\(id,layout,positions,view,updated_at\) VALUES\(1,\$1,\$2::jsonb,\$3::jsonb,now\(\)\) ON CONFLICT/.test(sql)) {
    s.layout = { layout: params[0], positions: parseJson(params[1]), view: parseJson(params[2]), updated_at: new Date().toISOString() };
    return done(result([], 1), true);
  }
  if (sql === 'TRUNCATE layout_state') { s.layout = null; return done(result(), true); }

  if (sql === 'SELECT username,password_hash FROM admin_account WHERE id=1' || sql === 'SELECT password_hash FROM admin_account WHERE id=1') {
    return result(s.admin ? [sql.includes('username') ? { username: s.admin.username, password_hash: s.admin.password_hash } : { password_hash: s.admin.password_hash }] : []);
  }
  if (/^INSERT INTO admin_account\(id,username,password_hash\) VALUES\(1,\$1,\$2\) ON CONFLICT \(id\) DO NOTHING$/.test(sql)) {
    if (s.admin) return result([], 0);
    s.admin = { username: params[0], password_hash: params[1] };
    return done(result([], 1), true);
  }
  if (sql === 'UPDATE admin_account SET password_hash=$1, updated_at=now() WHERE id=1') {
    if (!s.admin) return result([], 0);
    s.admin.password_hash = params[0];
    return done(result([], 1), true);
  }
  if (sql === 'TRUNCATE admin_account, admin_sessions') { s.admin = null; s.sessions = []; return done(result(), true); }

  if (sql === 'DELETE FROM admin_sessions WHERE expires_at < now()') {
    const before = s.sessions.length; const now = Date.now();
    s.sessions = s.sessions.filter(x => x.expires_at > now);
    return done(result([], before - s.sessions.length), before !== s.sessions.length);
  }
  if (SESSION_RE.test(sql)) {
    s.sessions.push({ token_hash: params[0], expires_at: Date.now() + Number(params[1]) });
    return done(result([], 1), true);
  }
  if (sql === 'SELECT token_hash FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()') {
    const now = Date.now();
    return result(s.sessions.filter(x => x.token_hash === params[0] && x.expires_at > now).map(x => ({ token_hash: x.token_hash })));
  }
  if (sql === 'DELETE FROM admin_sessions WHERE token_hash=$1') {
    const before = s.sessions.length; s.sessions = s.sessions.filter(x => x.token_hash !== params[0]);
    return done(result([], before - s.sessions.length), before !== s.sessions.length);
  }
  if (sql === 'DELETE FROM admin_sessions') { const n = s.sessions.length; s.sessions = []; return done(result([], n), n > 0); }

  throw new Error(`file-pool: unsupported statement: ${sql.slice(0, 120)}`);
}

// One statement at a time, and a transaction (connect ... release) keeps the lock for its whole life.
let tail = Promise.resolve();
function lock() {
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const ready = tail.then(() => release);
  tail = tail.then(() => next);
  return ready;
}

const pool = {
  async query(sql, params) {
    const release = await lock();
    try { return run(sql, params); } finally { release(); }
  },
  async connect() {
    const release = await lock();
    let released = false;
    return {
      async query(sql, params) { return run(sql, params); },
      release() {
        if (released) return;
        released = true;
        // A transaction left open (error path) is rolled back so it cannot leak into the next caller.
        if (snapshot) { state = snapshot; snapshot = null; }
        dirty = false;
        release();
      },
    };
  },
  async end() { /* nothing to close; every commit is already on disk */ },
};

module.exports = { pool, _reset() { state = null; snapshot = null; dirty = false; file = null; recoveredFromBackup = false; } };
