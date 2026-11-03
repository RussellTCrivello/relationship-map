// Downloads a remote image on behalf of the browser so it can be stored inside the program and
// shown offline. The browser cannot do this itself because most image hosts send no CORS headers.
//
// Safety: this is an outbound request driven by user input, so it is limited to http(s), refuses
// private/loopback/link-local addresses (checked on the address actually connected to, which also
// defeats DNS rebinding), follows at most 3 redirects, and caps time and size.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const ALLOWED_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const v = addr.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  return true;
}

const fail = (code, message) => Object.assign(new Error(message), { code, status: code === 'bad_url' ? 400 : 422 });

function getOnce(url, allowPrivate) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const lookup = (host, opts, cb) => {
      dns.lookup(host, { ...opts, all: false }, (err, address, family) => {
        if (err) return cb(err);
        if (!allowPrivate && isPrivateAddress(address)) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
        cb(null, address, family);
      });
    };
    const req = lib.get(url, {
      lookup,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'RelationshipMap/1.0', Accept: 'image/*' },
    }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })));
    req.on('error', reject);
  });
}

async function fetchImage(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch (_) { throw fail('bad_url', 'رابط غير صالح.'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw fail('bad_url', 'يجب أن يبدأ الرابط بـ http أو https.');
  if (!allowPrivate && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw fail('blocked', 'عنوان غير مسموح به.');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try { res = await getOnce(url, allowPrivate); }
    catch (e) {
      if (e.code === 'EPRIVATE') throw fail('blocked', 'عنوان غير مسموح به.');
      throw fail('unreachable', 'تعذر تنزيل الصورة (لا يوجد اتصال أو الرابط لا يعمل).');
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      try { url = new URL(res.headers.location, url); } catch (_) { throw fail('bad_url', 'تحويل غير صالح.'); }
      if (!/^https?:$/.test(url.protocol)) throw fail('bad_url', 'تحويل غير صالح.');
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw fail('unreachable', `الخادم البعيد ردّ بالحالة ${res.statusCode}.`); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim();
    if (!ALLOWED_TYPES.test(type)) { res.resume(); throw fail('not_image', 'الرابط لا يشير إلى صورة.'); }
    const declared = Number(res.headers['content-length']);
    if (declared > MAX_BYTES) { res.resume(); throw fail('too_large', 'الصورة كبيرة جدًا.'); }
    const chunks = []; let size = 0;
    await new Promise((resolve, reject) => {
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { res.destroy(); reject(fail('too_large', 'الصورة كبيرة جدًا.')); } else chunks.push(c); });
      res.on('end', resolve);
      res.on('error', () => reject(fail('unreachable', 'انقطع تنزيل الصورة.')));
      res.on('aborted', () => reject(fail('unreachable', 'انقطع تنزيل الصورة.')));
    });
    return { contentType: type.toLowerCase(), dataUrl: `data:${type.toLowerCase()};base64,${Buffer.concat(chunks).toString('base64')}` };
  }
  throw fail('unreachable', 'تحويلات كثيرة جدًا.');
}

module.exports = { fetchImage, isPrivateAddress };
