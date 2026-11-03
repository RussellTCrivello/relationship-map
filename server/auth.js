// Simple authentication for one administrator account: log in, log out, change the password.
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { pool } = require('./db');

const COOKIE = 'rm_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(password, salt)).toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
let dummyHash = null; // keeps response time similar for unknown user names

// Creates the administrator on first use. The initial password comes from ADMIN_PASSWORD, or is
// generated and printed once on the server console. Change it from the account menu after login.
async function getAdmin() {
  const found = await pool.query('SELECT username,password_hash FROM admin_account WHERE id=1');
  if (found.rowCount) return found.rows[0];
  const username = (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  await pool.query('INSERT INTO admin_account(id,username,password_hash) VALUES(1,$1,$2) ON CONFLICT (id) DO NOTHING', [username, await hashPassword(password)]);
  if (generated) console.log(`\n=== حساب المدير الأولي ===\nاسم المستخدم: ${username}\nكلمة المرور: ${password}\nغيّر كلمة المرور بعد أول دخول.\n==========================\n`);
  return (await pool.query('SELECT username,password_hash FROM admin_account WHERE id=1')).rows[0];
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const isSecure = req => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isSecure(req) ? '; Secure' : ''}`);
}
const clearSessionCookie = res => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);

async function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  await pool.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1, now() + ($2 || \' milliseconds\')::interval)', [sha256(token), String(SESSION_MS)]);
  return token;
}
async function currentSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const r = await pool.query('SELECT token_hash FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(token)]);
  return r.rowCount ? { tokenHash: r.rows[0].token_hash } : null;
}

// Blocks brute-force guessing: 5 failed logins per client per 15 minutes.
const attempts = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 5;
function limited(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) { attempts.delete(ip); return false; }
  return a.fails >= MAX_FAILS;
}
function recordFail(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) attempts.set(ip, { fails: 1, resetAt: Date.now() + WINDOW });
  else a.fails += 1;
}

const loginSchema = z.object({ username: z.string().max(100), password: z.string().max(200) }).strict();
const passwordSchema = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).strict();

const router = express.Router();

router.get('/me', async (req, res, next) => {
  try {
    const session = await currentSession(req);
    if (!session) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, username: (await getAdmin()).username });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const ip = req.ip || 'unknown';
    if (limited(ip)) return res.status(429).json({ error: 'too_many_attempts', message: 'محاولات كثيرة خاطئة. حاول مرة أخرى بعد 15 دقيقة.' });
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_payload', message: 'أدخل اسم المستخدم وكلمة المرور.' });
    const admin = await getAdmin();
    dummyHash = dummyHash || await hashPassword('dummy');
    const okUser = p.data.username.trim().toLowerCase() === admin.username.toLowerCase();
    const okPass = await verifyPassword(p.data.password, okUser ? admin.password_hash : dummyHash);
    if (!(okUser && okPass)) {
      recordFail(ip);
      return res.status(401).json({ error: 'invalid_credentials', message: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }
    attempts.delete(ip);
    setSessionCookie(req, res, await createSession());
    res.json({ ok: true, username: admin.username });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = readCookie(req, COOKIE);
    if (token) await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [sha256(token)]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const p = passwordSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid_payload', message: 'بيانات غير صالحة.' });
    const { currentPassword, newPassword } = p.data;
    const admin = await getAdmin();
    if (!(await verifyPassword(currentPassword, admin.password_hash))) return res.status(403).json({ error: 'wrong_password', message: 'كلمة المرور الحالية غير صحيحة.' });
    if (newPassword.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password', message: `كلمة المرور الجديدة قصيرة؛ استخدم ${MIN_PASSWORD} أحرف على الأقل.` });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'same_password', message: 'كلمة المرور الجديدة مطابقة للحالية.' });
    await pool.query('UPDATE admin_account SET password_hash=$1, updated_at=now() WHERE id=1', [await hashPassword(newPassword)]);
    // Every other device is signed out; this one continues with a fresh session.
    await pool.query('DELETE FROM admin_sessions');
    setSessionCookie(req, res, await createSession());
    res.json({ ok: true });
  } catch (e) { next(e); }
});

async function requireAuth(req, res, next) {
  try {
    if (await currentSession(req)) return next();
    res.status(401).json({ error: 'unauthorized', message: 'يلزم تسجيل الدخول.' });
  } catch (e) { next(e); }
}

module.exports = { router, requireAuth, hashPassword, verifyPassword, getAdmin };
