const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchImage, isPrivateAddress } = require('../server/image-fetch');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/a.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
      if (req.url === '/r') { res.statusCode = 302; res.setHeader('Location', '/a.png'); return res.end(); }
      if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); return res.end('<p>x</p>'); }
      res.statusCode = 404; res.end();
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('private addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('loopback and bad schemes are refused by default', async () => {
  await assert.rejects(fetchImage('http://127.0.0.1:1/a.png'), { code: 'blocked' });
  await assert.rejects(fetchImage('http://localhost:1/a.png'), { code: 'blocked' });
  await assert.rejects(fetchImage('file:///etc/passwd'), { code: 'bad_url' });
  await assert.rejects(fetchImage('not a url'), { code: 'bad_url' });
});

test('downloads an image, follows a redirect, rejects non-images', async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetchImage(`${base}/a.png`, { allowPrivate: true });
    assert.equal(r.contentType, 'image/png');
    assert.equal(Buffer.from(r.dataUrl.split(',')[1], 'base64').equals(PNG), true);
    assert.equal((await fetchImage(`${base}/r`, { allowPrivate: true })).contentType, 'image/png');
    await assert.rejects(fetchImage(`${base}/page`, { allowPrivate: true }), { code: 'not_image' });
    await assert.rejects(fetchImage(`${base}/missing`, { allowPrivate: true }), { code: 'unreachable' });
  } finally { srv.close(); }
});
