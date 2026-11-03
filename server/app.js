require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('node:path');
const { z } = require('zod');
const { pool } = require('./db');
const { router: authRouter, requireAuth, getAdmin } = require('./auth');
const { router: tilesRouter } = require('./tiles');
const { router: vectorMapRouter } = require('./vectormap');
// One validator for browser and server, so the API never stores data the page refuses to load.
const { validateDataset } = require('../src/data-validation.js');
const { exportProfile } = require('../src/profile.js');
const { fetchImage } = require('./image-fetch');

const ROOT = path.join(__dirname, '..');
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Sign-in: everything under /api (except the health check and the auth routes themselves) and the
// data files require a logged-in administrator. The page shell (HTML/CSS/JS) is public, but it
// contains no data and shows only a login form until the session is valid.
app.use('/api/auth', authRouter);
app.use('/api', (req, res, next) => (req.path === '/health' ? next() : requireAuth(req, res, next)));
app.use('/api/tiles', tilesRouter);
app.use('/api/vectormap', vectorMapRouter);

const record = z.record(z.unknown());
const graphSchema = z.object({
  nodes: z.array(record).max(100000),
  edges: z.array(record).max(200000),
  zones: z.array(record).max(10000).optional(),
  // Revision the client last saw. If it no longer matches, someone else saved in between.
  baseRevision: z.number().int().nonnegative().optional(),
  // Lets the server recognise a retry of a save that actually succeeded (lost response).
  requestId: z.string().min(1).max(100).optional(),
  // An earlier attempt by the same client whose outcome it never learned (see api-client.js).
  ackRequestId: z.string().min(1).max(100).optional(),
}).strict();

const finite = z.number().finite();
const layoutSchema = z.object({
  layout: z.enum(['grouped', 'concentric', 'classic']).optional(),
  positions: z.record(z.object({ x: finite.min(-1e6).max(1e6), y: finite.min(-1e6).max(1e6) }).strict()),
  scale: finite.min(0.05).max(10).optional(),
  tx: finite.min(-1e7).max(1e7).optional(),
  ty: finite.min(-1e7).max(1e7).optional(),
}).strict().refine(v => Object.keys(v.positions).length <= 100000, { message: 'too many positions' });

const idOf = x => String(x);
const coerceLegacyId = id => (/^-?\d+$/.test(id) ? Number(id) : id);
const httpError = (status, message) => Object.assign(new Error(message), { status });

function validateGraph(g) {
  try { validateDataset(g); } catch (e) { throw httpError(400, e.message); }
  return g;
}

const nodeRow = r => ({ ...r.attributes, id: coerceLegacyId(r.id) });
const edgeRow = r => ({ ...r.attributes, id: coerceLegacyId(r.id), source: coerceLegacyId(r.source_entity_id), target: coerceLegacyId(r.target_entity_id) });

// Reads revision, entities and relationships from one consistent snapshot.
async function readGraph() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const meta = await c.query('SELECT revision FROM graph_meta WHERE id=1');
    const zones = await c.query('SELECT zones FROM graph_meta WHERE id=1');
    const ns = await c.query('SELECT id,attributes FROM entities WHERE deleted_at IS NULL ORDER BY seq');
    const es = await c.query('SELECT id,source_entity_id,target_entity_id,attributes FROM relationships WHERE deleted_at IS NULL ORDER BY seq');
    await c.query('COMMIT');
    return { revision: Number(meta.rows[0]?.revision ?? 0), nodes: ns.rows.map(nodeRow), edges: es.rows.map(edgeRow), zones: zones.rows[0]?.zones || [] };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});

app.get('/api/graph', async (req, res, next) => {
  try { res.json(await readGraph()); } catch (e) { next(e); }
});

// Atomic full-graph replacement. A failed write rolls back and leaves the prior graph intact.
app.put('/api/graph', async (req, res, next) => {
  const parsed = graphSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', message: 'بنية البيانات غير صالحة.' });
  let g;
  try { g = validateGraph(parsed.data); }
  catch (e) { return res.status(e.status || 400).json({ error: 'validation_error', message: e.message }); }
  const { baseRevision, requestId, ackRequestId } = parsed.data;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const meta = (await c.query('SELECT revision,last_request_id FROM graph_meta WHERE id=1 FOR UPDATE')).rows[0];
    const current = Number(meta.revision);
    // The newest write is our own if it carries our request id (a retry) or the id of an earlier
    // attempt we never heard back about; in both cases the client's base is effectively current.
    const lastIsOurs = Boolean(meta.last_request_id) && (meta.last_request_id === requestId || meta.last_request_id === ackRequestId);
    if (baseRevision !== undefined && baseRevision !== current && !(lastIsOurs && meta.last_request_id !== requestId)) {
      await c.query('ROLLBACK');
      if (requestId && meta.last_request_id === requestId) {
        return res.json({ ok: true, duplicate: true, revision: current, nodes: g.nodes.length, edges: g.edges.length });
      }
      return res.status(409).json({ error: 'revision_conflict', revision: current, message: 'تغيّرت البيانات من نافذة أو جهاز آخر.' });
    }

    await c.query('DELETE FROM relationships');
    await c.query('DELETE FROM entities');
    if (g.nodes.length) {
      await c.query(
        `INSERT INTO entities(id,name,type,attributes)
         SELECT id,name,type,attributes FROM unnest($1::text[],$2::text[],$3::text[],$4::jsonb[]) WITH ORDINALITY AS t(id,name,type,attributes,ord) ORDER BY ord`,
        [g.nodes.map(n => idOf(n.id)), g.nodes.map(n => String(n.label)), g.nodes.map(n => String(n.schema || n.type || 'Thing')), g.nodes.map(n => JSON.stringify(n))]);
    }
    if (g.edges.length) {
      await c.query(
        `INSERT INTO relationships(id,source_entity_id,target_entity_id,type,attributes)
         SELECT id,source,target,type,attributes FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::jsonb[]) WITH ORDINALITY AS t(id,source,target,type,attributes,ord) ORDER BY ord`,
        [g.edges.map(e => idOf(e.id)), g.edges.map(e => idOf(e.source)), g.edges.map(e => idOf(e.target)), g.edges.map(e => String(e.type || 'Other')), g.edges.map(e => JSON.stringify(e))]);
    }
    // A legacy client that does not send zones must not silently delete them.
    if (g.zones !== undefined) await c.query('UPDATE graph_meta SET zones=$1::jsonb WHERE id=1', [JSON.stringify(g.zones)]);
    const next_ = (await c.query('UPDATE graph_meta SET revision=revision+1,last_request_id=$1,updated_at=now() WHERE id=1 RETURNING revision', [requestId || null])).rows[0];
    await c.query('COMMIT');
    res.json({ ok: true, revision: Number(next_.revision), nodes: g.nodes.length, edges: g.edges.length, savedAt: new Date().toISOString() });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    c.release();
  }
});

// Map arrangement (node positions + zoom/pan). Independent of the graph revision: it is a view
// setting, so the last save wins and it never blocks or conflicts with data edits.
app.get('/api/layout', async (req, res, next) => {
  try {
    const row = (await pool.query('SELECT layout,positions,view,updated_at FROM layout_state WHERE id=1')).rows[0];
    if (!row) return res.json({ empty: true });
    // Drop positions of entities that no longer exist so deleted nodes do not linger.
    const ids = new Set((await pool.query('SELECT id FROM entities WHERE deleted_at IS NULL')).rows.map(r => r.id));
    const positions = Object.fromEntries(Object.entries(row.positions || {}).filter(([id]) => ids.has(id)));
    res.json({ version: 1, layout: row.layout, positions, ...row.view, savedAt: row.updated_at });
  } catch (e) { next(e); }
});
app.put('/api/layout', async (req, res, next) => {
  const parsed = layoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', message: 'بنية ترتيب الخريطة غير صالحة.' });
  const { layout, positions, scale, tx, ty } = parsed.data;
  try {
    const view = {};
    if (scale !== undefined) view.scale = scale;
    if (tx !== undefined) view.tx = tx;
    if (ty !== undefined) view.ty = ty;
    await pool.query(
      `INSERT INTO layout_state(id,layout,positions,view,updated_at) VALUES(1,$1,$2::jsonb,$3::jsonb,now())
       ON CONFLICT (id) DO UPDATE SET layout=EXCLUDED.layout,positions=EXCLUDED.positions,view=EXCLUDED.view,updated_at=now()`,
      [layout || 'grouped', JSON.stringify(positions), JSON.stringify(view)]);
    res.json({ ok: true, nodes: Object.keys(positions).length, savedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

app.get('/api/entities', async (req, res, next) => {
  try { res.json((await readGraph()).nodes); } catch (e) { next(e); }
});
app.get('/api/entities/:id', async (req, res, next) => {
  try {
    const r = await pool.query('SELECT id,attributes FROM entities WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(nodeRow(r.rows[0]));
  } catch (e) { next(e); }
});
app.get('/api/relationships', async (req, res, next) => {
  try { res.json((await readGraph()).edges); } catch (e) { next(e); }
});
app.post('/api/import/validate', (req, res) => {
  const p = graphSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ valid: false, error: 'invalid_payload' });
  try { validateGraph(p.data); res.json({ valid: true, nodes: p.data.nodes.length, edges: p.data.edges.length }); }
  catch (e) { res.status(400).json({ valid: false, error: e.message }); }
});
// Downloads a remote image so the page can keep a copy inside the program (offline use).
app.post('/api/images/fetch', async (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || url.length > 2048) return res.status(400).json({ error: 'bad_url', message: 'رابط غير صالح.' });
  try { res.json(await fetchImage(url, { allowPrivate: process.env.IMAGE_FETCH_ALLOW_PRIVATE === '1' })); }
  catch (e) { res.status(e.status || 502).json({ error: e.code || 'fetch_failed', message: e.message }); }
});
app.get('/api/export', async (req, res, next) => {
  try {
    const graph = await readGraph(), includeSensitive = req.query.includeSensitive === 'true';
    graph.nodes = graph.nodes.map(n => { const copy = { ...n }; if (copy.profile) { const p = exportProfile(copy.profile, includeSensitive); if (p) copy.profile = p; else delete copy.profile; } return copy; });
    res.json({ exportedAt: new Date().toISOString(), ...graph });
  } catch (e) { next(e); }
});

// Serve only what the browser needs. Serving the whole project folder would expose
// server code, package files and backups/*.dump database dumps over HTTP.
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
for (const dir of ['assets', 'src']) app.use(`/${dir}`, express.static(path.join(ROOT, dir)));
app.use('/data', requireAuth, express.static(path.join(ROOT, 'data')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'JSON غير صالح.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'حجم البيانات كبير جدًا.' });
  console.error('Request failed.');
  res.status(500).json({ error: 'internal_error', message: 'حدث خطأ داخلي. لم يتم تأكيد العملية.' });
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  getAdmin().then(() => app.listen(port, host, () => {
    console.log(`Relationship Map listening on http://${host}:${port}`);
    // Explicitly enabled only by the local Windows launcher; never interpolate external input.
    if (process.platform === 'win32' && process.env.OPEN_BROWSER === '1' && host === '127.0.0.1' && String(port) === '3000') {
      const child = require('node:child_process').spawn('cmd.exe', ['/d', '/s', '/c', 'start "" "http://127.0.0.1:3000"'], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', () => console.warn('Open http://127.0.0.1:3000 manually.'));child.unref();
    }
  }))
    .catch(err => { console.error('تعذر بدء الخادم:', err.message, '\nهل نفّذت npm run migrate؟'); process.exit(1); });
}
module.exports = { app };
